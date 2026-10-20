import {
  NodeConnectionTypes,
  sleep,
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow';
import {
  approvalReplayKey,
  itemIdempotencyKey,
  outcomeOf,
  waitForApproval,
} from '../../lib/veefore';
import {
  GUARD_MESSAGES,
  actionOf,
  calledNode,
  matchTool,
  requestFor,
  type GuardAnswer,
  type GuardedNode,
  type VeeforeToolEntry,
} from '../../lib/guard';
import { gatewayFor } from '../Veefore/gateway';

/**
 * Veefore Guard.
 *
 * Wire n8n tools (Gmail, Slack, HTTP Request, …) into the Guard, and the
 * Guard into the AI Agent. The model sees those tools as usual; n8n asks the
 * Guard before every call (its human-in-the-loop tool gate) and runs the tool
 * only when the Guard says yes. The Guard asks Veefore: the agent's policy,
 * risk and approvals decide, and every call is in Veefore's audit trail. n8n
 * keeps performing the action with its own credential.
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
          'Connect tools to this node, and this node to the AI Agent. Veefore decides each call: allowed calls run, refused ones never do, and the agent is told why. Add each action for this agent in Veefore (Integrations → n8n) with "n8n performs it".',
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
    const workflow = this.getWorkflow();
    let instance: string | null = null;
    let instanceId: string | null = null;
    try {
      instance = this.getInstanceBaseUrl();
    } catch {
      instance = null;
    }
    try {
      instanceId = this.getInstanceId() || null;
    } catch {
      instanceId = null;
    }

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
      const label = target?.name ?? (toolName || 'this tool');
      if (!target) {
        answer({
          approved: false,
          chatInput: GUARD_MESSAGES.unknown(label),
          veefore: { status: 'refused', reason: 'tool_not_found' },
        });
        continue;
      }
      try {
        const gateway = await gatewayFor(this);
        tools ??= (await gateway.tools()) as unknown as VeeforeToolEntry[];
        const action = actionOf(target);
        const tool = matchTool(tools, action);
        if (!tool) {
          answer({
            approved: false,
            chatInput: GUARD_MESSAGES.unknown(label),
            veefore: { status: 'refused', reason: 'no_veefore_tool', n8n_action: { ...action } },
          });
          continue;
        }
        if (tool.kind && tool.kind !== 'CLIENT') {
          answer({
            approved: false,
            chatInput: GUARD_MESSAGES.veeforePerforms(label),
            veefore: { status: 'refused', reason: 'veefore_performs', tool: tool.key },
          });
          continue;
        }
        const { parameters, unresolved } = requestFor(target, toolParameters);
        const runtime = {
          connectionId: null,
          instance,
          workflowId: workflow.id ? String(workflow.id) : null,
          executionId: this.getExecutionId() ?? null,
          step: target.name,
        };
        const idempotencyKey = itemIdempotencyKey({
          instanceId: instanceId ?? instance,
          workflowId: runtime.workflowId,
          executionId: runtime.executionId,
          node: `${node.name}:${target.name}:${String(json.toolCallId ?? '')}`,
          itemIndex,
          tool: tool.key,
          parameters,
        });
        const base = {
          tool: tool.key,
          parameters,
          idempotencyKey,
          runtime,
          ...(unresolved.length > 0
            ? { purpose: `n8n fills ${unresolved.join(', ')} from an expression at run time.` }
            : {}),
        };
        let decision = await gateway.execute(base);
        let outcome = outcomeOf(decision);
        const approval = decision.approval as
          | { approval_id?: string; expires_at?: string; status?: string }
          | null
          | undefined;
        if (outcome === 'approval' && approval?.approval_id) {
          const status = await waitForApproval(
            gateway,
            approval.approval_id,
            sleep,
            Date.now,
            waitMs,
          );
          if (status === 'PENDING') {
            answer({
              approved: false,
              chatInput: GUARD_MESSAGES.pending(label, approval.expires_at),
              veefore: {
                status: 'approval',
                approval_id: approval.approval_id,
                expires_at: approval.expires_at ?? null,
                action_id: decision.action_id ?? null,
              },
            });
            continue;
          }
          if (status !== 'APPROVED') {
            answer({
              approved: false,
              chatInput:
                status === 'DENIED' ? GUARD_MESSAGES.denied(label) : GUARD_MESSAGES.expired(label),
              veefore: { status: 'refused', approval_status: status },
            });
            continue;
          }
          decision = await gateway.execute({
            ...base,
            approvalId: approval.approval_id,
            idempotencyKey: approvalReplayKey(idempotencyKey, approval.approval_id),
          });
          outcome = outcomeOf(decision);
        }
        if (outcome === 'allowed') {
          answer({
            approved: true,
            veefore: {
              status: 'allowed',
              tool: tool.key,
              action_id: decision.action_id ?? null,
            },
          });
          continue;
        }
        answer({
          approved: false,
          chatInput: GUARD_MESSAGES.refused(
            label,
            String(decision.reason ?? '')
              .trim()
              .replace(/\.+$/, ''),
          ),
          veefore: {
            status: 'refused',
            decision: (decision.decision ?? null) as string | null,
            reason: (decision.reason ?? null) as string | null,
            action_id: (decision.action_id ?? null) as string | null,
          },
        });
      } catch (error) {
        // Fail closed: no answer from Veefore means the tool does not run.
        answer({
          approved: false,
          chatInput: GUARD_MESSAGES.unreachable(label, (error as Error).message ?? 'no answer'),
          veefore: { status: 'error', message: (error as Error).message ?? null },
        });
      }
    }
    return [answers];
  }
}
