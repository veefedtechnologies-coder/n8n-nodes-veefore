import { sleep, type IDataObject } from 'n8n-workflow';
import {
  approvalReplayKey,
  itemIdempotencyKey,
  outcomeOf,
  waitForApproval,
  type ActionBatch,
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

/** Said of a request that joined others of the same action already waiting for approval. */
export const JOINED_PREFIX =
  'Added to the requests like it that are already waiting: one approval covers all of them. ';

/** Whether an approval joined requests of its batch already waiting (the gateway counts them). */
export function joinedWaiting(approval: { batch_waiting?: unknown } | null | undefined): boolean {
  const waiting = Number(approval?.batch_waiting ?? 1);
  return Number.isFinite(waiting) && waiting > 1;
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
    | { approval_id?: string; expires_at?: string; batch_waiting?: unknown }
    | null
    | undefined;
  if (outcome === 'approval' && approval?.approval_id) {
    // It joined this run's requests of the action already waiting: they are
    // one approval, decided later, so this one does not wait again.
    const joined = joinedWaiting(approval);
    approvalStatus = await waitForApproval(
      gateway,
      approval.approval_id,
      sleep,
      Date.now,
      joined ? 0 : waitMs,
    );
    if (approvalStatus === 'PENDING') {
      // Still undecided: Veefore carries it out if it is approved later.
      const handover = await gateway
        .handOver(approval.approval_id, base)
        .then((answer) => ({ ok: true as const, answer }))
        .catch((error: Error) => ({ ok: false as const, error }));
      return {
        ...summarize('approval', decision, 'PENDING'),
        message: handover.ok
          ? `${joined ? JOINED_PREFIX : ''}${handedOverMessage(approval.expires_at)}`
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

/** One item of a batch call: the request for it, and what it is. */
export interface BatchCall {
  input: ActionInput;
  label: string | null;
}

/** How many of a batch's requests are sent at once. */
export const BATCH_CONCURRENCY = 5;

/** `run` for every item, at most `limit` at a time, results in order. */
async function eachLimited<T, R>(
  items: T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await run(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Where one item of a batch ended up. */
export type BatchItemStatus = 'done' | 'waiting' | 'refused' | 'failed' | 'error';

export interface BatchItemState {
  decision: Record<string, unknown> | null;
  outcome: Outcome;
  approvalStatus?: string;
  /** Veefore could not be asked. */
  error?: string;
  /** Waiting: Veefore carries it out once approved (or could not take it over: why). */
  handedOver?: boolean;
  handoverError?: string;
  expiresAt?: string;
}

function statusOf(state: BatchItemState): BatchItemStatus {
  if (state.error !== undefined) return 'error';
  if (state.outcome === 'allowed') return 'done';
  if (state.outcome === 'approval') return 'waiting';
  return state.decision?.outcome === 'FAILED' ? 'failed' : 'refused';
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the model should say about a batch, all of it at once. */
export function batchMessage(states: BatchItemState[]): string {
  const total = states.length;
  const by = (status: BatchItemStatus) => states.filter((state) => statusOf(state) === status);
  const done = by('done').length;
  const waiting = by('waiting');
  const refused = by('refused');
  const failed = by('failed').length;
  const errors = by('error').length;
  const parts: string[] = [];
  if (done === total)
    return `Done: all ${total} were carried out. Veefore allowed them. Tell the user.`;
  if (done > 0) parts.push(`Done: ${done} of ${total} carried out.`);
  if (waiting.length > 0) {
    const expiries = waiting
      .map((state) => state.expiresAt)
      .filter((at): at is string => typeof at === 'string')
      .sort();
    const until = untilText(expiries[0]);
    const all = waiting.length === total ? `All ${total}` : count(waiting.length, 'item');
    if (waiting.every((state) => state.handedOver)) {
      parts.push(
        `Not done yet: ${all} wait for a person to approve them in Veefore, in one approval for all of them. Veefore carries them out automatically if they are approved ${until}; nothing more is needed from you or the user. If they are denied, or no one decides in time, they will not happen.`,
      );
    } else {
      const why = waiting.find((state) => !state.handedOver)?.handoverError ?? 'no answer';
      parts.push(
        `Not done yet: ${all} wait for a person to approve them in Veefore, and will not happen on their own (${why.replace(/\.$/, '')}). Once they are approved ${until}, the user should ask again; then call this tool again with the same items.`,
      );
    }
  }
  if (refused.length > 0) {
    const reasons = [
      ...new Set(
        refused.map((state) =>
          state.approvalStatus === 'DENIED'
            ? 'a person denied it'
            : state.approvalStatus === 'EXPIRED'
              ? 'no one approved it in time'
              : String(state.decision?.reason ?? '')
                  .trim()
                  .replace(/\.+$/, ''),
        ),
      ),
    ].filter(Boolean);
    parts.push(
      `Not done: ${count(refused.length, 'item')} refused${reasons.length === 1 ? ` (${reasons[0]})` : ''}; each item says why.`,
    );
  }
  if (failed > 0) {
    parts.push(
      `Failed: ${count(failed, 'item')} did not complete; each item says why. Do not assume ${failed === 1 ? 'it' : 'they'} happened.`,
    );
  }
  if (errors > 0) {
    parts.push(
      `Not done: Veefore could not be asked about ${count(errors, 'item')}; the user can try ${errors === 1 ? 'it' : 'them'} again in a moment.`,
    );
  }
  parts.push(
    waiting.length > 0
      ? 'Tell the user exactly this, and do not call this tool again for the items waiting for approval.'
      : 'Tell the user exactly this.',
  );
  return parts.join(' ');
}

/**
 * An AI agent's call for several items of one action Veefore performs
 * (delete every draft): every request is sent, and those that need a person
 * wait in one approval card, decided at once. It waits once, up to `waitMs`,
 * then each approved item is carried out and the rest are handed to Veefore,
 * which carries them out if they are approved later.
 */
export async function runVeeforeBatch(
  gateway: VeeforeGateway,
  calls: BatchCall[],
  waitMs: number,
  options: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<IDataObject> {
  const wait = options.sleep ?? sleep;
  const now = options.now ?? Date.now;
  const states = await eachLimited(
    calls,
    BATCH_CONCURRENCY,
    async ({ input }): Promise<BatchItemState> => {
      try {
        const decision = await gateway.execute(input);
        return { decision, outcome: outcomeOf(decision) };
      } catch (error) {
        return {
          decision: null,
          outcome: 'refused',
          error: (error as Error).message ?? 'no answer',
        };
      }
    },
  );
  const held = states.flatMap((state, index) => {
    const approval = state.decision?.approval as
      | { approval_id?: string; expires_at?: string }
      | null
      | undefined;
    return state.outcome === 'approval' && approval?.approval_id
      ? [{ state, index, approvalId: approval.approval_id, expiresAt: approval.expires_at }]
      : [];
  });
  if (held.length > 0) {
    // One decision covers the batch: wait on its first request, then read the rest.
    const first = await waitForApproval(gateway, held[0]!.approvalId, wait, now, waitMs).catch(
      () => 'PENDING',
    );
    await eachLimited(
      held,
      BATCH_CONCURRENCY,
      async ({ state, index, approvalId, expiresAt }, k) => {
        const input = calls[index]!.input;
        const status =
          k === 0
            ? first
            : await waitForApproval(gateway, approvalId, wait, now, 0).catch(() => 'PENDING');
        state.approvalStatus = status;
        state.expiresAt = expiresAt;
        if (status === 'APPROVED') {
          try {
            state.decision = await gateway.execute({
              ...input,
              approvalId,
              idempotencyKey: approvalReplayKey(input.idempotencyKey, approvalId),
            });
            state.outcome = outcomeOf(state.decision);
          } catch (error) {
            state.outcome = 'refused';
            state.error = (error as Error).message ?? 'no answer';
          }
        } else if (status === 'PENDING') {
          // Still undecided: Veefore carries it out if it is approved later.
          try {
            await gateway.handOver(approvalId, input);
            state.handedOver = true;
          } catch (error) {
            state.handedOver = false;
            state.handoverError = (error as Error).message ?? 'the hand-over failed';
          }
        } else {
          state.outcome = 'refused';
        }
      },
    );
  }
  const items = states.map((state, index) => {
    const status = statusOf(state);
    const decision = state.decision ?? {};
    const approval = (decision.approval ?? null) as IDataObject | null;
    return {
      item: index + 1,
      label: calls[index]!.label,
      status,
      message:
        status === 'error'
          ? `Veefore could not be asked (${state.error}), so it was NOT done.`
          : status === 'waiting'
            ? state.handedOver
              ? 'Waiting for a person to approve it in Veefore, which then carries it out.'
              : 'Waiting for a person to approve it in Veefore; it will not happen on its own.'
            : messageFor(state.outcome, decision, state.approvalStatus),
      approval_id: (approval?.approval_id as string | undefined) ?? null,
      action_id: (decision.action_id ?? null) as string | null,
      result: (decision.result && typeof decision.result === 'object'
        ? decision.result
        : null) as IDataObject | null,
    };
  });
  const tally = (status: BatchItemStatus) => items.filter((item) => item.status === status).length;
  return {
    status: 'batch',
    message: batchMessage(states),
    total: items.length,
    done: tally('done'),
    waiting: tally('waiting'),
    refused: tally('refused'),
    failed: tally('failed') + tally('error'),
    items,
  } as IDataObject;
}

/** A call still waiting for a person when the agent answered. */
export interface PendingCall {
  approvalId: string;
  expiresAt: string | null;
  /** The exact request Veefore holds the approval for. */
  request: ActionInput;
}

export type FollowOutcome = 'performed' | 'failed' | 'denied' | 'expired' | 'refused' | 'error';

/** Approvals being followed in this n8n process: one follower each. */
const following = new Map<string, Promise<FollowOutcome>>();

/**
 * At most this many approvals are followed at once in one n8n process. Each
 * follower keeps its run's tools in memory until the approval is decided
 * (up to 24 hours), so the number is bounded; beyond it the user asks again.
 */
export const MAX_FOLLOWERS = 200;

/** Whether this approval is (or can be) followed now. */
export function canFollow(approvalId: string): boolean {
  return following.has(approvalId) || following.size < MAX_FOLLOWERS;
}

/**
 * Tells Veefore what happened to an action n8n performed. Never throws: an
 * older gateway without the endpoint, or a moment without network, must not
 * turn a done action into an error. Logged instead.
 */
export async function reportClientResult(
  gateway: VeeforeGateway,
  actionId: string | null,
  status: 'SUCCEEDED' | 'FAILED',
  error: string | null,
  log: (message: string, meta?: Record<string, unknown>) => void = () => undefined,
): Promise<boolean> {
  if (!actionId) return false;
  try {
    await gateway.reportResult(actionId, { status, error });
    return true;
  } catch (failure) {
    log(`Veefore: could not record the result of ${actionId}: ${(failure as Error).message}`, {
      actionId,
      status,
    });
    return false;
  }
}

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
          // Already used (the user asked again and it ran), the n8n step is
          // gone, or policy changed: Veefore refused it.
          log(`Veefore: the approved action was not run: ${String(decision.reason ?? 'refused')}`, {
            reason: decision.reason ?? null,
          });
          return 'refused';
        }
        // Claimed: from here on Veefore records whether n8n really did it.
        const actionId = typeof decision.action_id === 'string' ? decision.action_id : null;
        try {
          await perform();
        } catch (error) {
          const message = (error as Error).message ?? 'The n8n tool failed.';
          log(`Veefore: the approved action failed in n8n: ${message}`, { error: message });
          await reportClientResult(gateway, actionId, 'FAILED', message, log);
          return 'failed';
        }
        await reportClientResult(gateway, actionId, 'SUCCEEDED', null, log);
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
    /** Decided with the run's other calls of this action (one approval card). */
    batch?: ActionBatch;
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
      ...(input.batch ? { batch: input.batch } : {}),
    };
    let decision = await gateway.execute(base);
    let outcome = outcomeOf(decision);
    const approval = decision.approval as
      | { approval_id?: string; expires_at?: string; status?: string; batch_waiting?: unknown }
      | null
      | undefined;
    if (outcome === 'approval' && approval?.approval_id) {
      // Joined others of this run already waiting: decided with them, later.
      const status = await waitForApproval(
        gateway,
        approval.approval_id,
        sleep,
        Date.now,
        joinedWaiting(approval) ? 0 : input.waitMs,
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
