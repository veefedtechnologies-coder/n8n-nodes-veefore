import {
  NodeConnectionTypes,
  NodeOperationError,
  sleep,
  type IDataObject,
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type ResourceMapperField,
  type ResourceMapperFields,
  type ResourceMapperValue,
} from 'n8n-workflow';
import {
  TOOL_APPROVAL_WAIT_MS,
  VeeforeGatewayError,
  approvalReplayKey,
  itemIdempotencyKey,
  outcomeOf,
  waitForApproval,
  type Outcome,
} from '../../lib/veefore';
import { gatewayFor } from './gateway';
import { fieldsFromSchema, parametersFromMapper, type JsonSchema } from './schema';

/**
 * Veefore for n8n.
 *
 * "Run Tool" sends the request to the Veefore gateway, which checks the
 * agent's tools, policy, risk and approvals, leases the provider credential
 * from its broker and performs the call itself. The workflow never holds the
 * provider secret, and a refused action never happened.
 *
 * Outcomes are routed, not hidden in options: Allowed, Refused, and Needs
 * Approval each have their own output. When a person must approve, the node
 * waits for the decision made in Veefore (for as long as the approval is open)
 * and then runs the approved action, or routes the item to Needs Approval if
 * the workflow should carry on instead.
 *
 * As a tool for an AI Agent the same node returns one result the model can
 * read, and fills each tool parameter from the model.
 */

const OUTPUT_INDEX: Record<Outcome, number> = { allowed: 0, refused: 1, approval: 2 };

/** What an AI agent, or a person reading the output, should take from a decision. */
function messageFor(outcome: Outcome, decision: Record<string, unknown>, status?: string): string {
  const reason = String(decision.reason ?? '')
    .trim()
    .replace(/\.+$/, '');
  if (outcome === 'allowed') {
    const result = decision.result as { client_executed?: unknown } | null | undefined;
    // "Veefore decides, n8n performs": nothing has happened yet.
    if (result && typeof result === 'object' && result.client_executed === true)
      return 'Veefore allowed this. It is not done yet: the node on the Allowed output performs it.';
    return 'Done. Veefore allowed this and it was carried out.';
  }
  if (outcome === 'approval')
    return 'Waiting for a person to approve this in Veefore. Nothing has been done yet.';
  if (status === 'DENIED') return `A person denied this in Veefore. Nothing was done.`;
  if (status === 'EXPIRED') return 'No one approved this in time. Nothing was done.';
  if (decision.outcome === 'FAILED')
    return `Veefore allowed this, but the tool did not complete${reason ? `: ${reason}` : ''}. Do not assume it happened.`;
  return `Veefore refused this${reason ? `: ${reason}` : ''}. Nothing was done.`;
}

function summarize(
  outcome: Outcome,
  decision: Record<string, unknown>,
  approvalStatus?: string,
): IDataObject {
  const approval = (decision.approval ?? null) as IDataObject | null;
  return {
    status: outcome,
    message: messageFor(outcome, decision, approvalStatus),
    performed_by:
      outcome !== 'allowed'
        ? null
        : (decision.result as { client_executed?: unknown } | null)?.client_executed === true
          ? 'n8n'
          : 'veefore',
    decision: (decision.decision ?? decision.result ?? null) as string | null,
    outcome: (decision.outcome ?? null) as string | null,
    reason: (decision.reason ?? null) as string | null,
    action_id: (decision.action_id ?? null) as string | null,
    approval_id: (approval?.approval_id as string | undefined) ?? null,
    approval_status: approvalStatus ?? (approval?.status as string | undefined) ?? null,
    result: (decision.result && typeof decision.result === 'object'
      ? decision.result
      : null) as IDataObject | null,
    ...(decision.authorization_id
      ? {
          authorization_id: decision.authorization_id as string,
          expires_at: decision.expires_at as string,
        }
      : {}),
  };
}

export class Veefore implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Veefore',
    name: 'veefore',
    icon: { light: 'file:veefore.svg', dark: 'file:veefore.dark.svg' },
    group: ['transform'],
    version: 1,
    subtitle:
      '={{$parameter["operation"] + ($parameter["tool"] ? ": " + $parameter["tool"] : "")}}',
    description: 'Run actions through Veefore policy, approvals and credential brokering',
    defaults: { name: 'Veefore' },
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main, NodeConnectionTypes.Main, NodeConnectionTypes.Main],
    outputNames: ['Allowed', 'Refused', 'Needs Approval'],
    usableAsTool: true,
    credentials: [{ name: 'veeforeApi', required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Run Tool',
            value: 'execute',
            action: 'Run a protected tool',
            description: 'Veefore decides, asks a person when policy says so, and runs it',
          },
          {
            name: 'Check Only',
            value: 'authorize',
            action: 'Check whether a tool call would be allowed',
            description: 'Get the decision without running anything',
          },
          {
            name: 'List Tools',
            value: 'listTools',
            action: 'List the tools this agent may use',
          },
          {
            name: 'Get Approval',
            value: 'approvalStatus',
            action: 'Get the status of an approval',
          },
        ],
        default: 'execute',
      },
      {
        displayName: 'Tool Name or ID',
        name: 'tool',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getTools' },
        default: '',
        required: true,
        description:
          'A tool this agent may use, as configured in Veefore. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { operation: ['execute', 'authorize'] } },
      },
      {
        displayName: 'Send Parameters As',
        name: 'inputMode',
        type: 'options',
        options: [
          { name: 'Fields', value: 'fields', description: "From the tool's parameter list" },
          { name: 'JSON', value: 'json' },
        ],
        default: 'fields',
        displayOptions: { show: { operation: ['execute', 'authorize'] } },
      },
      {
        displayName: 'Parameters',
        name: 'parameters',
        type: 'resourceMapper',
        noDataExpression: true,
        default: { mappingMode: 'defineBelow', value: null },
        required: true,
        typeOptions: {
          loadOptionsDependsOn: ['tool'],
          resourceMapper: {
            resourceMapperMethod: 'getToolParameters',
            mode: 'add',
            fieldWords: { singular: 'parameter', plural: 'parameters' },
            addAllFields: true,
            multiKeyMatch: false,
            supportAutoMap: false,
            noFieldsError: 'This tool declares no parameters in Veefore. Use JSON to send some.',
          },
        },
        displayOptions: { show: { operation: ['execute', 'authorize'], inputMode: ['fields'] } },
      },
      {
        displayName: 'Parameters (JSON)',
        name: 'parametersJson',
        type: 'json',
        default: '{}',
        description: 'Approval and checks are bound to these exact values',
        displayOptions: { show: { operation: ['execute', 'authorize'], inputMode: ['json'] } },
      },
      {
        displayName: 'When a Person Must Approve',
        name: 'onApproval',
        type: 'options',
        options: [
          {
            name: 'Wait for Their Decision',
            value: 'wait',
            description:
              'Pause here until the approval is decided in Veefore, then run it (Allowed) or stop (Refused)',
          },
          {
            name: 'Continue on Needs Approval Output',
            value: 'route',
            description: 'Do not wait; the item leaves on the Needs Approval output',
          },
        ],
        default: 'wait',
        description:
          'Whether approval is needed is decided by your Veefore policy, not here. This only says what the workflow does meanwhile.',
        displayOptions: { show: { operation: ['execute'], '@tool': [false] } },
      },
      {
        displayName:
          'The model fills in each parameter. Veefore decides whether it runs, and waits for a person when your policy asks for approval.',
        name: 'toolNotice',
        type: 'notice',
        default: '',
        displayOptions: { show: { '@tool': [true] } },
      },
      {
        displayName: 'Approval ID',
        name: 'approvalId',
        type: 'string',
        default: '',
        required: true,
        description: 'From the Needs Approval output of an earlier Veefore node',
        displayOptions: { show: { operation: ['approvalStatus'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { operation: ['execute', 'authorize'] } },
        options: [
          {
            displayName: 'Purpose',
            name: 'purpose',
            type: 'string',
            default: '',
            description: 'Why the action is being taken. Shown to approvers and recorded.',
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getTools(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const gateway = await gatewayFor(this);
        const tools = await gateway.tools();
        return tools.map((tool) => ({
          name: String(tool.name ?? tool.key),
          value: String(tool.key),
          description: String(tool.description || tool.key),
        }));
      },
    },
    resourceMapping: {
      async getToolParameters(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
        const toolKey = String(this.getCurrentNodeParameter('tool') ?? '');
        if (!toolKey) return { fields: [], emptyFieldsNotice: 'Choose a tool first.' };
        const gateway = await gatewayFor(this);
        const tool = (await gateway.tools()).find((entry) => entry.key === toolKey);
        if (!tool) {
          return {
            fields: [],
            emptyFieldsNotice: 'This agent may not use that tool. Check its access in Veefore.',
          };
        }
        const asTool = this.getNode().type.endsWith('Tool');
        const fields: ResourceMapperField[] = fieldsFromSchema(
          (tool.parameter_schema ?? {}) as JsonSchema,
          { fromAi: asTool },
        );
        return { fields };
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const gateway = await gatewayFor(this);
    const workflow = this.getWorkflow();
    const node = this.getNode();
    const asTool = node.type.endsWith('Tool');
    let instance: string | null = null;
    try {
      instance = this.getInstanceBaseUrl();
    } catch {
      instance = null;
    }
    let instanceId: string | null = null;
    try {
      instanceId = this.getInstanceId() || null;
    } catch {
      instanceId = null;
    }
    const runtime = {
      connectionId: null,
      instance,
      workflowId: workflow.id ? String(workflow.id) : null,
      executionId: this.getExecutionId() ?? null,
      step: node.name,
    };

    // The tool's own schema, fetched once per run, so list fields typed as
    // text ("a@x.com, b@x.com") reach Veefore as lists.
    let toolList: Array<Record<string, unknown>> | null = null;
    const toolSchema = async (key: string): Promise<JsonSchema | undefined> => {
      toolList ??= await gateway.tools();
      return toolList.find((entry) => entry.key === key)?.parameter_schema as
        | JsonSchema
        | undefined;
    };

    const outputs: INodeExecutionData[][] = [[], [], []];
    const emit = (outcome: Outcome, json: IDataObject, itemIndex: number) => {
      // An AI agent reads only the first output; it gets every outcome there.
      outputs[asTool ? 0 : OUTPUT_INDEX[outcome]]!.push({ json, pairedItem: { item: itemIndex } });
    };

    for (let itemIndex = 0; itemIndex < Math.max(items.length, 1); itemIndex += 1) {
      const operation = this.getNodeParameter('operation', itemIndex) as string;
      try {
        if (operation === 'listTools') {
          const tools = await gateway.tools();
          outputs[0]!.push({
            json: {
              tools: tools.map(({ key, name, description, capability, risk_level }) => ({
                key,
                name,
                description,
                capability,
                risk_level,
              })) as IDataObject[],
            },
            pairedItem: { item: itemIndex },
          });
          continue;
        }
        if (operation === 'approvalStatus') {
          const approvalId = (this.getNodeParameter('approvalId', itemIndex) as string).trim();
          const approval = await gateway.approvalStatus(approvalId);
          const status = String(approval.status ?? 'PENDING');
          const outcome: Outcome =
            status === 'APPROVED' ? 'allowed' : status === 'PENDING' ? 'approval' : 'refused';
          emit(outcome, approval as IDataObject, itemIndex);
          continue;
        }

        const tool = String(this.getNodeParameter('tool', itemIndex) ?? '').trim();
        if (!tool)
          throw new NodeOperationError(node, 'Choose the Veefore tool to run.', { itemIndex });
        const inputMode = this.getNodeParameter('inputMode', itemIndex, 'fields') as string;
        const parameters =
          inputMode === 'json'
            ? parseJsonParameters(
                this,
                this.getNodeParameter('parametersJson', itemIndex, '{}'),
                itemIndex,
              )
            : parametersFromMapper(
                this.getNodeParameter('parameters', itemIndex, null) as ResourceMapperValue | null,
                await toolSchema(tool),
              );
        const options = this.getNodeParameter('options', itemIndex, {}) as IDataObject;
        const idempotencyKey = itemIdempotencyKey({
          instanceId: instanceId ?? instance,
          workflowId: runtime.workflowId,
          executionId: runtime.executionId,
          node: node.name,
          itemIndex,
          tool,
          parameters,
        });
        const base = {
          tool,
          parameters,
          purpose: (options.purpose as string | undefined) || undefined,
          idempotencyKey,
          runtime,
        };

        if (operation === 'authorize') {
          const decision = await gateway.authorize(base);
          const outcome = outcomeOf(decision);
          emit(
            outcome,
            { ...summarize(outcome, decision), message: checkMessage(outcome, decision) },
            itemIndex,
          );
          continue;
        }

        let decision = await gateway.execute(base);
        let outcome = outcomeOf(decision);
        let approvalStatus: string | undefined;
        const approval = decision.approval as
          | { approval_id?: string; expires_at?: string }
          | null
          | undefined;
        const onApproval = asTool
          ? 'wait'
          : (this.getNodeParameter('onApproval', itemIndex, 'wait') as string);
        if (outcome === 'approval' && approval?.approval_id && onApproval === 'wait') {
          // An AI agent answers its chat after a short wait; a workflow waits
          // for as long as the approval is open.
          approvalStatus = await waitForApproval(
            gateway,
            approval.approval_id,
            sleep,
            Date.now,
            asTool ? TOOL_APPROVAL_WAIT_MS : undefined,
          );
          if (approvalStatus === 'PENDING') {
            // Still undecided: Veefore carries it out if it is approved later.
            const handover = await gateway
              .handOver(approval.approval_id, base)
              .then((answer) => ({ ok: true as const, answer }))
              .catch((error: Error) => ({ ok: false as const, error }));
            emit(
              'approval',
              {
                ...summarize('approval', decision, 'PENDING'),
                message: handover.ok
                  ? handedOverMessage(approval.expires_at)
                  : notHandedOverMessage(approval.expires_at, handover.error.message),
                handed_over: handover.ok,
                expires_at: approval.expires_at ?? null,
              },
              itemIndex,
            );
            continue;
          }
          if (approvalStatus === 'APPROVED') {
            decision = await gateway.execute({
              ...base,
              approvalId: approval.approval_id,
              idempotencyKey: approvalReplayKey(idempotencyKey, approval.approval_id),
            });
            outcome = outcomeOf(decision);
          } else {
            outcome = 'refused';
          }
        }
        emit(outcome, summarize(outcome, decision, approvalStatus), itemIndex);
      } catch (error) {
        if (this.continueOnFail()) {
          outputs[asTool ? 0 : 1]!.push({
            json: { status: 'error', message: (error as Error).message },
            pairedItem: { item: itemIndex },
          });
          continue;
        }
        if (error instanceof VeeforeGatewayError) {
          throw new NodeOperationError(node, error.message, {
            itemIndex,
            description: error.code ?? undefined,
          });
        }
        throw new NodeOperationError(node, error as Error, { itemIndex });
      }
    }
    return asTool ? [outputs[0]!] : outputs;
  }
}

/** When the approval runs out, in words. */
function untilText(expiresAt: string | undefined): string {
  if (!expiresAt) return 'before the approval expires';
  const minutes = Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60_000));
  const when = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16);
  if (minutes >= 120) {
    const hours = Math.round(minutes / 60);
    return `within about ${hours} hours (by ${when} UTC)`;
  }
  return `within about ${minutes} minute${minutes === 1 ? '' : 's'} (by ${when} UTC)`;
}

/** What the chat should say once Veefore has taken it over. */
function handedOverMessage(expiresAt: string | undefined): string {
  return `Not done yet: a person must approve this in Veefore first. Veefore will carry it out automatically if they approve it ${untilText(expiresAt)}; nothing more is needed from you or the user. If they deny it or no one decides in time, it will not happen. Tell the user exactly this, and do not call this tool again for the same request.`;
}

/** The action cannot be done later by Veefore (n8n performs it, or the hand-over failed). */
function notHandedOverMessage(expiresAt: string | undefined, why: string): string {
  return `Not done yet: a person must approve this in Veefore first, and it will not happen on its own (${why.replace(/\.$/, '')}). Tell the user it is waiting for approval, and that once it is approved ${untilText(expiresAt)} they should ask again; then call this tool again with the same request.`;
}

function checkMessage(outcome: Outcome, decision: Record<string, unknown>): string {
  const reason = String(decision.reason ?? '')
    .trim()
    .replace(/\.+$/, '');
  if (outcome === 'allowed') return 'Veefore would allow this. Nothing was run.';
  if (outcome === 'approval') return 'This would need a person to approve it. Nothing was run.';
  return `Veefore would refuse this${reason ? `: ${reason}` : ''}. Nothing was run.`;
}

function parseJsonParameters(
  node: IExecuteFunctions,
  raw: unknown,
  itemIndex: number,
): Record<string, unknown> {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // Reported below with the item it came from.
    }
  }
  throw new NodeOperationError(node.getNode(), 'Parameters must be a JSON object.', { itemIndex });
}
