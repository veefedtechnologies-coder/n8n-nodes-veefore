import {
  NodeConnectionTypes,
  type IDataObject,
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  type SupplyData,
} from 'n8n-workflow';
import { itemIdempotencyKey, type VeeforeGateway } from '../../lib/veefore';
import type { GuardedNode, VeeforeToolEntry } from '../../lib/guard';
import {
  INPUTS_EXPRESSION,
  TOOLS_MESSAGES,
  argumentsFor,
  needsN8nTools,
  planTools,
  selectionValue,
  type ConnectedTool,
  type Plan,
  type PlanEntry,
} from '../../lib/agent-tools';
import { decideN8nCall, originOf, runVeeforeCall } from '../Veefore/calls';
import { gatewayFor } from '../Veefore/gateway';

/**
 * Veefore Tools: the agent's Veefore actions, several in one node.
 *
 * Pick the actions in **Actions**. Each one is offered to the AI Agent as a
 * tool, and Veefore decides every call (policy, risk, approvals):
 *
 *  - an action Veefore performs is carried out by the gateway;
 *  - an action n8n performs is carried out by the n8n tool wired into this
 *    node's **n8n Tools** input (shown once such an action is picked), and
 *    only after Veefore allows that exact call.
 *
 * Tools wired in only reach the model through this node, and only for the
 * picked actions n8n performs.
 *
 * n8n's AI Agent runs a call by executing this node with the tool's name and
 * arguments (`execute`); older agents call the tool directly (`supplyData`'s
 * `invoke`). Both go through `callTool`.
 */

type Context = ISupplyDataFunctions | IExecuteFunctions;

interface Prepared {
  plan: Plan;
  gateway: VeeforeGateway;
}

function waitMsOf(context: Context, itemIndex: number): number {
  return Math.max(0, Number(context.getNodeParameter('waitMinutes', itemIndex, 2)) || 0) * 60_000;
}

/** The n8n tools wired into this node, toolkits flattened. */
async function connectedTools(context: Context, itemIndex: number): Promise<ConnectedTool[]> {
  let raw: unknown;
  try {
    raw = await context.getInputConnectionData(NodeConnectionTypes.AiTool, itemIndex);
  } catch {
    // No n8n Tools input (no picked action n8n performs), or nothing wired in.
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.flatMap((entry) => {
    const toolkit = entry as { tools?: unknown };
    return (Array.isArray(toolkit.tools) ? toolkit.tools : [entry]) as ConnectedTool[];
  });
}

async function prepare(context: Context, itemIndex: number): Promise<Prepared> {
  const node = context.getNode();
  const selected = context.getNodeParameter('tools', itemIndex, []) as string[];
  const gateway = await gatewayFor(context);
  const available = (await gateway.tools()) as unknown as VeeforeToolEntry[];
  const wired = needsN8nTools(selected) ? await connectedTools(context, itemIndex) : [];
  const nodes = wired.length
    ? (context.getParentNodes(node.name, {
        connectionType: NodeConnectionTypes.AiTool,
        depth: 1,
        includeNodeParameters: true,
      }) as GuardedNode[])
    : [];
  return { plan: planTools(selected, available, wired, nodes), gateway };
}

function parsed(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/** One call from the model: Veefore decides, then the right side performs it. */
async function callTool(
  context: Context,
  prepared: Prepared,
  entry: PlanEntry,
  input: Record<string, unknown>,
  itemIndex: number,
  callId: string,
): Promise<IDataObject> {
  const node = context.getNode();
  const args = argumentsFor(entry, input);
  const waitMs = waitMsOf(context, itemIndex);
  const origin = originOf(context);
  const callKey = `${node.name}:${entry.name}:${callId}`;
  const label = entry.tool.name || entry.tool.key;

  if (entry.kind === 'missing') {
    return { status: 'refused', message: TOOLS_MESSAGES.notConnected(label) };
  }
  if (entry.kind === 'veefore') {
    const idempotencyKey = itemIdempotencyKey({
      instanceId: origin.instanceScope,
      workflowId: origin.runtime.workflowId,
      executionId: origin.runtime.executionId,
      node: callKey,
      itemIndex,
      tool: entry.tool.key,
      parameters: args,
    });
    return runVeeforeCall(
      prepared.gateway,
      { tool: entry.tool.key, parameters: args, idempotencyKey, runtime: origin.runtime },
      waitMs,
    );
  }
  const answer = await decideN8nCall(prepared.gateway, {
    // The picked action, not any other one that happens to match the node.
    tools: [entry.tool],
    target: entry.node,
    toolParameters: args,
    waitMs,
    origin,
    callKey,
    itemIndex,
  });
  if (!answer.approved) {
    return {
      status: String(answer.veefore.status ?? 'refused'),
      message: answer.chatInput ?? 'Veefore did not allow this. It was NOT done.',
      veefore: answer.veefore as IDataObject,
    };
  }
  const result = await entry.connected.invoke(args);
  return { response: parsed(result) as IDataObject, veefore: answer.veefore as IDataObject };
}

function addHints(context: Context, plan: Plan): void {
  if (plan.hints.length === 0) return;
  try {
    (context as ISupplyDataFunctions).addExecutionHints?.(
      ...plan.hints.map((message) => ({ message, type: 'warning' as const })),
    );
  } catch {
    // Hints are advice for the editor; never a reason to fail the run.
  }
}

// An AI tool node: it is a tool provider, so `usableAsTool` would add a
// second, meaningless "Veefore Tools Tool". The rule is
// @n8n/community-nodes/node-usable-as-tool; it is not named here because the
// monorepo's ESLint does not load that plugin.
// eslint-disable-next-line
export class VeeforeTools implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Veefore Tools',
    name: 'veeforeTools',
    icon: { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{ ($parameter.tools || []).length + " action(s)" }}',
    description:
      "Give an AI Agent this agent's Veefore actions. n8n tools connected here run only when Veefore allows the call.",
    defaults: { name: 'Veefore' },
    codex: {
      alias: ['guard', 'approval', 'policy', 'human in the loop', 'veefore'],
      categories: ['AI'],
      subcategories: { AI: ['Tools'], Tools: ['Other Tools'] },
      resources: {
        primaryDocumentation: [{ url: 'https://docs.veefore.com/build/n8n' }],
      },
    },
    inputs: INPUTS_EXPRESSION,
    outputs: [{ displayName: 'Tools', type: NodeConnectionTypes.AiTool }],
    credentials: [{ name: 'veeforeApi', required: true }],
    properties: [
      {
        displayName:
          'Pick the actions this agent may take. Veefore decides every call. For an action marked "n8n performs it", connect the matching n8n tool (Gmail, Slack, …) to this node\'s n8n Tools input instead of to the agent: it then runs only when Veefore allows it.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Action Names or IDs',
        name: 'tools',
        type: 'multiOptions',
        typeOptions: { loadOptionsMethod: 'getAgentTools' },
        default: [],
        required: true,
        description:
          'The Veefore actions offered to the model, as set up for this agent in Veefore. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
      {
        displayName: 'Wait for a Decision (Minutes)',
        name: 'waitMinutes',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 1440 },
        default: 2,
        description:
          'When a person must approve, how long the agent waits before answering. An action Veefore performs is then carried out by Veefore if it is approved later; for one n8n performs, the user asks again once it is approved.',
      },
    ],
  };

  methods = {
    loadOptions: {
      async getAgentTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const gateway = await gatewayFor(this);
        const tools = (await gateway.tools()) as unknown as Array<
          VeeforeToolEntry & { description?: string }
        >;
        return tools.map((tool) => ({
          name: `${tool.name || tool.key} (${tool.kind === 'CLIENT' ? 'n8n performs it' : 'Veefore performs it'})`,
          value: selectionValue(tool),
          description: String(tool.description || tool.key),
        }));
      },
    },
  };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const node = this.getNode();
    const prepared = await prepare(this, itemIndex);
    addHints(this, prepared.plan);
    const tools = prepared.plan.entries.map((entry) => {
      const run = async (input: unknown) =>
        JSON.stringify(
          await callTool(
            this,
            prepared,
            entry,
            (input && typeof input === 'object' ? input : {}) as Record<string, unknown>,
            itemIndex,
            '',
          ),
        );
      return {
        name: entry.name,
        description: entry.description,
        schema: entry.schema,
        returnDirect: false,
        metadata: { isFromToolkit: true, sourceNodeName: node.name },
        invoke: run,
        call: run,
      };
    });
    // n8n recognises a toolkit by its shape: `tools` and `getTools()`.
    return { response: { tools, getTools: () => tools } };
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    let prepared: Prepared | null = null;
    for (let itemIndex = 0; itemIndex < Math.max(items.length, 1); itemIndex += 1) {
      const json = (items[itemIndex]?.json ?? {}) as Record<string, unknown>;
      const name = typeof json.tool === 'string' ? json.tool : '';
      try {
        prepared ??= await prepare(this, itemIndex);
        const entry = prepared.plan.entries.find((candidate) => candidate.name === name);
        const result = entry
          ? await callTool(this, prepared, entry, json, itemIndex, String(json.toolCallId ?? ''))
          : { status: 'refused', message: TOOLS_MESSAGES.unknownCall(name) };
        out.push({ json: result, pairedItem: { item: itemIndex } });
      } catch (error) {
        // Fail closed, and tell the model, rather than stopping the agent.
        out.push({
          json: {
            status: 'error',
            message: `Veefore could not be asked (${(error as Error).message}), so it was NOT done. Tell the user to try again in a moment.`,
          },
          pairedItem: { item: itemIndex },
        });
      }
    }
    return [out];
  }
}
