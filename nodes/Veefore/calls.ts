import { sleep, type IDataObject } from 'n8n-workflow';
import {
  approvalReplayKey,
  itemIdempotencyKey,
  outcomeOf,
  waitForApproval,
  type ActionInput,
  type Outcome,
  type RuntimeContext,
  type VeeforeGateway,
} from '../../lib/veefore';
import {
  GUARD_MESSAGES,
  actionOf,
  matchTool,
  requestFor,
  type GuardAnswer,
  type GuardedNode,
  type VeeforeToolEntry,
} from '../../lib/guard';

/** The part of n8n's node context that says where a call comes from. */
export interface CallSource {
  getNode(): { name: string };
  getWorkflow(): { id?: string | number | null };
  getExecutionId(): string;
  getInstanceBaseUrl(): string;
  getInstanceId(): string;
}

export interface CallOrigin {
  runtime: RuntimeContext;
  /** Scopes idempotency keys to this n8n instance. */
  instanceScope: string | null;
}

export function originOf(context: CallSource, step?: string): CallOrigin {
  let instance: string | null = null;
  let instanceId: string | null = null;
  try {
    instance = context.getInstanceBaseUrl();
  } catch {
    instance = null;
  }
  try {
    instanceId = context.getInstanceId() || null;
  } catch {
    instanceId = null;
  }
  const workflow = context.getWorkflow();
  let executionId: string | null = null;
  try {
    executionId = context.getExecutionId() ?? null;
  } catch {
    executionId = null;
  }
  return {
    runtime: {
      connectionId: null,
      instance,
      workflowId: workflow.id ? String(workflow.id) : null,
      executionId,
      step: step ?? context.getNode().name,
    },
    instanceScope: instanceId ?? instance,
  };
}

/** What an AI agent, or a person reading the output, should take from a decision. */
export function messageFor(
  outcome: Outcome,
  decision: Record<string, unknown>,
  status?: string,
): string {
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

export function summarize(
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

/** When the approval runs out, in words. */
export function untilText(expiresAt: string | undefined): string {
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
export function handedOverMessage(expiresAt: string | undefined): string {
  return `Not done yet: a person must approve this in Veefore first. Veefore will carry it out automatically if they approve it ${untilText(expiresAt)}; nothing more is needed from you or the user. If they deny it or no one decides in time, it will not happen. Tell the user exactly this, and do not call this tool again for the same request.`;
}

/** The action cannot be done later by Veefore (n8n performs it, or the hand-over failed). */
export function notHandedOverMessage(expiresAt: string | undefined, why: string): string {
  return `Not done yet: a person must approve this in Veefore first, and it will not happen on its own (${why.replace(/\.$/, '')}). Tell the user it is waiting for approval, and that once it is approved ${untilText(expiresAt)} they should ask again; then call this tool again with the same request.`;
}

/**
 * An AI agent's call to an action Veefore performs: decide, wait up to
 * `waitMs` for a person, and hand it to Veefore if no one has decided yet.
 */
export async function runVeeforeCall(
  gateway: VeeforeGateway,
  base: ActionInput,
  waitMs: number,
): Promise<IDataObject> {
  let decision = await gateway.execute(base);
  let outcome = outcomeOf(decision);
  let approvalStatus: string | undefined;
  const approval = decision.approval as
    | { approval_id?: string; expires_at?: string }
    | null
    | undefined;
  if (outcome === 'approval' && approval?.approval_id) {
    approvalStatus = await waitForApproval(gateway, approval.approval_id, sleep, Date.now, waitMs);
    if (approvalStatus === 'PENDING') {
      // Still undecided: Veefore carries it out if it is approved later.
      const handover = await gateway
        .handOver(approval.approval_id, base)
        .then((answer) => ({ ok: true as const, answer }))
        .catch((error: Error) => ({ ok: false as const, error }));
      return {
        ...summarize('approval', decision, 'PENDING'),
        message: handover.ok
          ? handedOverMessage(approval.expires_at)
          : notHandedOverMessage(approval.expires_at, handover.error.message),
        handed_over: handover.ok,
        expires_at: approval.expires_at ?? null,
      };
    }
    if (approvalStatus === 'APPROVED') {
      decision = await gateway.execute({
        ...base,
        approvalId: approval.approval_id,
        idempotencyKey: approvalReplayKey(base.idempotencyKey, approval.approval_id),
      });
      outcome = outcomeOf(decision);
    } else {
      outcome = 'refused';
    }
  }
  return summarize(outcome, decision, approvalStatus);
}

/** A call still waiting for a person when the agent answered. */
export interface PendingCall {
  approvalId: string;
  expiresAt: string | null;
  /** The exact request Veefore holds the approval for. */
  request: ActionInput;
}

export type FollowOutcome = 'performed' | 'denied' | 'expired' | 'refused' | 'error';

/** Approvals being followed in this n8n process: one follower each. */
const following = new Map<string, Promise<FollowOutcome>>();

/** How often a follower asks: every 10 s for 10 minutes, then every minute. */
export function followInterval(elapsedMs: number): number {
  return elapsedMs < 10 * 60_000 ? 10_000 : 60_000;
}

/**
 * Keeps waiting for a held n8n-performed call after the agent has answered,
 * and performs it with the n8n tool once a person approves it.
 *
 * The run itself is claimed from Veefore with the approval (consumed once,
 * atomically), so the action happens at most once even if the user also asks
 * again: whichever comes first runs it, the other is refused. A denial or an
 * expiry ends it. It lives in this n8n process: if n8n restarts first, the
 * user asks again once it is approved.
 */
export function followApproval(
  gateway: VeeforeGateway,
  pending: PendingCall,
  perform: () => Promise<unknown>,
  options: {
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (message: string, meta?: Record<string, unknown>) => void;
  } = {},
): Promise<FollowOutcome> {
  const existing = following.get(pending.approvalId);
  if (existing) return existing;
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => undefined);
  const started = now();
  const run = (async (): Promise<FollowOutcome> => {
    try {
      for (;;) {
        await wait(followInterval(now() - started));
        let status: string;
        try {
          status = await waitForApproval(gateway, pending.approvalId, wait, now, 0);
        } catch (error) {
          // Veefore unreachable for a moment: keep waiting, within the expiry.
          log('Veefore: could not check the approval yet', { error: (error as Error).message });
          const expires = pending.expiresAt ? new Date(pending.expiresAt).getTime() : NaN;
          if (Number.isFinite(expires) && now() > expires + 60_000) return 'expired';
          continue;
        }
        if (status === 'PENDING') continue;
        if (status === 'DENIED') return 'denied';
        if (status !== 'APPROVED') return 'expired';
        const decision = await gateway.execute({
          ...pending.request,
          approvalId: pending.approvalId,
          idempotencyKey: approvalReplayKey(pending.request.idempotencyKey, pending.approvalId),
        });
        if (outcomeOf(decision) !== 'allowed') {
          // Already used (the user asked again and it ran), or policy changed.
          log('Veefore: the approved action was not run again', {
            reason: decision.reason ?? null,
          });
          return 'refused';
        }
        await perform();
        log('Veefore: performed the approved action', { approvalId: pending.approvalId });
        return 'performed';
      }
    } catch (error) {
      log(`Veefore: the approved action failed: ${(error as Error).message}`, {
        error: (error as Error).message,
        stack: (error as Error).stack,
      });
      return 'error';
    } finally {
      following.delete(pending.approvalId);
    }
  })();
  following.set(pending.approvalId, run);
  return run;
}

/**
 * An AI agent's call to an n8n tool behind Veefore: may it run? Fails closed:
 * no matching Veefore action, an action Veefore performs, or no answer all
 * mean no.
 */
export async function decideN8nCall(
  gateway: VeeforeGateway,
  input: {
    tools: VeeforeToolEntry[];
    target: GuardedNode;
    toolParameters: Record<string, unknown>;
    waitMs: number;
    origin: CallOrigin;
    /** Names the call within the execution (the tool call id). */
    callKey: string;
    itemIndex: number;
    /** Why the agent takes this action, shown to approvers. */
    purpose?: string;
  },
): Promise<GuardAnswer> {
  const { target, origin } = input;
  const label = target.name;
  try {
    const action = actionOf(target);
    const tool = matchTool(input.tools, action);
    if (!tool) {
      return {
        approved: false,
        chatInput: GUARD_MESSAGES.unknown(label),
        veefore: { status: 'refused', reason: 'no_veefore_tool', n8n_action: { ...action } },
      };
    }
    if (tool.kind && tool.kind !== 'CLIENT') {
      return {
        approved: false,
        chatInput: GUARD_MESSAGES.veeforePerforms(label),
        veefore: { status: 'refused', reason: 'veefore_performs', tool: tool.key },
      };
    }
    const { parameters, unresolved } = requestFor(target, input.toolParameters);
    const runtime = { ...origin.runtime, step: target.name };
    const idempotencyKey = itemIdempotencyKey({
      instanceId: origin.instanceScope,
      workflowId: runtime.workflowId,
      executionId: runtime.executionId,
      node: input.callKey,
      itemIndex: input.itemIndex,
      tool: tool.key,
      parameters,
    });
    const purpose = [
      input.purpose,
      unresolved.length > 0
        ? `n8n fills ${unresolved.join(', ')} from an expression at run time.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    const base: ActionInput = {
      tool: tool.key,
      parameters,
      idempotencyKey,
      runtime,
      ...(purpose ? { purpose } : {}),
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
        input.waitMs,
      );
      if (status === 'PENDING') {
        return {
          approved: false,
          chatInput: GUARD_MESSAGES.pending(label, approval.expires_at),
          pending: {
            approvalId: approval.approval_id,
            expiresAt: approval.expires_at ?? null,
            request: base,
          },
          veefore: {
            status: 'approval',
            approval_id: approval.approval_id,
            expires_at: approval.expires_at ?? null,
            action_id: decision.action_id ?? null,
          },
        };
      }
      if (status !== 'APPROVED') {
        return {
          approved: false,
          chatInput:
            status === 'DENIED' ? GUARD_MESSAGES.denied(label) : GUARD_MESSAGES.expired(label),
          veefore: { status: 'refused', approval_status: status },
        };
      }
      decision = await gateway.execute({
        ...base,
        approvalId: approval.approval_id,
        idempotencyKey: approvalReplayKey(idempotencyKey, approval.approval_id),
      });
      outcome = outcomeOf(decision);
    }
    if (outcome === 'allowed') {
      return {
        approved: true,
        veefore: { status: 'allowed', tool: tool.key, action_id: decision.action_id ?? null },
      };
    }
    return {
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
    };
  } catch (error) {
    // Fail closed: no answer from Veefore means the tool does not run.
    return {
      approved: false,
      chatInput: GUARD_MESSAGES.unreachable(label, (error as Error).message ?? 'no answer'),
      veefore: { status: 'error', message: (error as Error).message ?? null },
    };
  }
}
