import {
  NodeConnectionTypes,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import {
  GUARD_MESSAGES,
  calledNode,
  type GuardAnswer,
  type GuardedNode,
  type VeeforeToolEntry,
} from '../../lib/guard';
import { decideN8nCall, originOf } from '../Veefore/calls';
import { gatewayFor } from '../Veefore/gateway';

/**
 * Veefore Guard (superseded by Veefore Tools, kept so workflows that use it
 * keep working; hidden from the nodes panel).
 *
 * n8n tools wired into the Guard run only after Veefore allows the call: n8n
 * asks the Guard before every call (its human-in-the-loop tool gate) and runs
 * the tool only when the Guard says yes.
 *
 * The node's type ends in `HitlTool`, which is how n8n recognises a tool gate.
 */
// It is a tool gate, not a tool: `usableAsTool` would make n8n generate a
// second "Veefore Guard Tool" that has no Tool input and gates nothing. The
// rule is @n8n/community-nodes/node-usable-as-tool; it is not named here
// because the monorepo's ESLint does not load that plugin.
// eslint-disable-next-line
export class VeeforeGuardHitlTool implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Veefore Guard',
    name: 'veeforeGuardHitlTool',
    icon: { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' },
    group: ['transform'],
    version: 1,
    hidden: true,
    subtitle: 'Veefore decides each tool call',
    description: 'Run the connected tools only when Veefore allows the call',
    defaults: { name: 'Veefore Guard' },
    codex: {
      categories: ['AI'],
      subcategories: { AI: ['Tools'], Tools: ['Human in the Loop'] },
      resources: {
        primaryDocumentation: [{ url: 'https://docs.veefore.com/build/n8n' }],
      },
    },
    inputs: [{ displayName: 'Tool', type: NodeConnectionTypes.AiTool, required: true }],
    outputs: [
      {
        displayName: 'Guarded tools',
        type: NodeConnectionTypes.AiTool,
        filter: {
          nodes: ['@n8n/n8n-nodes-langchain.agent', '@n8n/n8n-nodes-langchain.agentTool'],
        },
      },
    ],
    credentials: [{ name: 'veeforeApi', required: true }],
    properties: [
      {
        displayName:
          "Veefore Tools replaces this node: one node for all of the agent's Veefore actions, with an n8n Tools input for the actions n8n performs. This node keeps working.",
        name: 'notice',
        type: 'notice',
        default: '',
      },
      {
        displayName: 'Wait for a Decision (Minutes)',
        name: 'waitMinutes',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: 1440 },
        default: 2,
        description:
          'When a person must approve, how long the agent waits before answering. After that it tells the user to ask again once approved; the approval stays open (24 hours by default).',
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const node = this.getNode();
    const items = this.getInputData();
    const waitMs = Math.max(0, Number(this.getNodeParameter('waitMinutes', 0, 2)) || 0) * 60_000;
    const guarded = this.getParentNodes(node.name, {
      connectionType: NodeConnectionTypes.AiTool,
      depth: 1,
      includeNodeParameters: true,
    }) as GuardedNode[];
    const origin = originOf(this);

    const answers: INodeExecutionData[] = [];
    let tools: VeeforeToolEntry[] | null = null;
    for (let itemIndex = 0; itemIndex < Math.max(items.length, 1); itemIndex += 1) {
      const json = (items[itemIndex]?.json ?? {}) as IDataObject;
      const toolName = typeof json.tool === 'string' ? json.tool : '';
      const toolParameters =
        json.toolParameters && typeof json.toolParameters === 'object'
          ? (json.toolParameters as Record<string, unknown>)
          : {};
      const answer = (value: GuardAnswer) =>
        answers.push({ json: value as unknown as IDataObject, pairedItem: { item: itemIndex } });

      const target = calledNode(guarded, toolName);
      if (!target) {
        answer({
          approved: false,
          chatInput: GUARD_MESSAGES.unknown(toolName || 'this tool'),
          veefore: { status: 'refused', reason: 'tool_not_found' },
        });
        continue;
      }
      try {
        const gateway = await gatewayFor(this);
        tools ??= (await gateway.tools()) as unknown as VeeforeToolEntry[];
        answer(
          await decideN8nCall(gateway, {
            tools,
            target,
            toolParameters,
            waitMs,
            origin,
            callKey: `${node.name}:${target.name}:${String(json.toolCallId ?? '')}`,
            itemIndex,
          }),
        );
      } catch (error) {
        // Fail closed: no answer from Veefore means the tool does not run.
        answer({
          approved: false,
          chatInput: GUARD_MESSAGES.unreachable(
            target.name,
            (error as Error).message ?? 'no answer',
          ),
          veefore: { status: 'error', message: (error as Error).message ?? null },
        });
      }
    }
    return [answers];
  }
}
