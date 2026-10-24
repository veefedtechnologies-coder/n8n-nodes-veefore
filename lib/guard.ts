import type { ActionInput } from './veefore';

/**
 * n8n tools that run only after Veefore allows the call (the n8n Tools input
 * of Veefore Tools). The Veefore gateway decides: policy, risk and approvals.
 *
 * This file holds the decisions, with no n8n imports, so they are tested on
 * their own:
 *
 *  - which n8n node and operation the model is calling, and its Veefore tool;
 *  - the request Veefore is asked about: the node's own field values, the
 *    model's arguments placed into them (`$fromAI`), so a policy sees the
 *    real recipient or amount, not only what the model chose to name;
 *  - what the agent is told when Veefore refuses or a person has not decided.
 *
 * It fails closed: an unknown tool, a tool set to "Veefore performs it", an
 * unreachable gateway or an unreadable answer all mean the tool does not run.
 */

/** A node wired into the Guard's Tool input, as n8n reports it. */
export interface GuardedNode {
  name: string;
  type: string;
  disabled?: boolean;
  parameters?: Record<string, unknown>;
}

/** A tool as the gateway lists it for the agent. */
export interface VeeforeToolEntry {
  key: string;
  name?: string;
  description?: string;
  kind?: string;
  parameter_schema?: Record<string, unknown> | null;
  /** The app it belongs to (gateways from 3.4 on): "WhatsApp Business Cloud", "Send message". */
  app?: { id: string; name: string; action?: string | null } | null;
}

/** The n8n catalog action a tool node performs: `n8n-nodes-base.gmail:message.send`. */
export interface N8nAction {
  node: string;
  resource: string | null;
  operation: string | null;
}

/** How n8n names a tool after its node (`Send a message` → `Send_a_message`). */
export function toolNameOf(nodeName: string): string {
  let name = nodeName.replace(/[^a-zA-Z0-9_-]+/g, '_');
  if (name.length > 64) name = name.slice(0, 64).replace(/[_-]+$/, '');
  return name;
}

/** The node the model is calling: by its tool name, else the only one wired in. */
export function calledNode(nodes: GuardedNode[], toolName: unknown): GuardedNode | null {
  const live = nodes.filter((node) => node.disabled !== true);
  if (typeof toolName === 'string' && toolName) {
    const match = live.find((node) => toolNameOf(node.name) === toolName || node.name === toolName);
    if (match) return match;
  }
  return live.length === 1 ? live[0]! : null;
}

/** `n8n-nodes-base.gmailTool` performs `n8n-nodes-base.gmail`'s actions. */
export function actionOf(node: GuardedNode): N8nAction {
  const base = node.type.replace(/Tool$/, '');
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    node: base,
    resource: text(node.parameters?.resource),
    operation: text(node.parameters?.operation),
  };
}

/** The agent's Veefore tool for that action, from the catalog origin in its schema. */
export function matchTool(tools: VeeforeToolEntry[], action: N8nAction): VeeforeToolEntry | null {
  const origin = (tool: VeeforeToolEntry) =>
    (tool.parameter_schema?.['x-veefore-n8n'] ?? null) as {
      node?: unknown;
      resource?: unknown;
      operation?: unknown;
    } | null;
  const same = (a: unknown, b: string | null) => (a ?? null) === b || (a === '' && b === null);
  const candidates = tools.filter((tool) => origin(tool)?.node === action.node);
  const exact = candidates.filter(
    (tool) =>
      same(origin(tool)!.resource, action.resource) &&
      same(origin(tool)!.operation, action.operation),
  );
  if (exact.length > 0) {
    // The one n8n performs, when both kinds exist.
    return exact.find((tool) => tool.kind === 'CLIENT') ?? exact[0]!;
  }
  return null;
}

const FROM_AI = /\$fromAI\(\s*(['"`])((?:\\.|(?!\1).)+)\1/;

/**
 * The request Veefore is asked about: each of the node's fields with the
 * value n8n will send. A field filled by the model (`$fromAI('To')`) gets the
 * model's argument; a fixed value is sent as it is; any other expression is
 * left out (Veefore cannot know its value) and listed. Collections ("Options")
 * are flattened to their fields, as the Veefore tool's schema names them.
 */
export function requestFor(
  node: GuardedNode,
  toolParameters: Record<string, unknown>,
): { parameters: Record<string, unknown>; unresolved: string[] } {
  const parameters: Record<string, unknown> = {};
  const unresolved: string[] = [];
  const used = new Set<string>();
  const skip = new Set([
    'resource',
    'operation',
    'authentication',
    'descriptionType',
    'toolDescription',
  ]);
  const visit = (name: string, value: unknown): void => {
    if (skip.has(name)) return;
    if (typeof value === 'string') {
      if (value.startsWith('=')) {
        const fromAi = FROM_AI.exec(value);
        if (fromAi) {
          const key = fromAi[2]!;
          used.add(key);
          if (toolParameters[key] !== undefined) parameters[name] = toolParameters[key];
          return;
        }
        unresolved.push(name);
        return;
      }
      if (value !== '') parameters[name] = value;
      return;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      // A resource locator: its value.
      if (record.__rl === true) {
        visit(name, record.value);
        return;
      }
      for (const [child, entry] of Object.entries(record)) visit(child, entry);
      return;
    }
    if (value !== undefined && value !== null) parameters[name] = value;
  };
  for (const [name, value] of Object.entries(node.parameters ?? {})) visit(name, value);
  // Arguments the model sent that no field names: kept, so nothing is hidden.
  for (const [key, value] of Object.entries(toolParameters)) {
    if (!used.has(key) && parameters[key] === undefined) parameters[key] = value;
  }
  return { parameters, unresolved };
}

/** The Guard's answer to n8n: run the tool, or tell the agent why not. */
export interface GuardAnswer {
  approved: boolean;
  /** For a refusal, what the agent should take from it (n8n passes it to the model). */
  chatInput?: string;
  /** Still waiting for a person: what Veefore holds the approval for. */
  pending?: { approvalId: string; expiresAt: string | null; request: ActionInput };
  veefore: Record<string, unknown>;
}

function until(expiresAt: unknown): string {
  if (typeof expiresAt !== 'string') return 'before the approval expires';
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return 'before the approval expires';
  const minutes = Math.max(1, Math.round((at.getTime() - Date.now()) / 60_000));
  const when = at.toISOString().replace('T', ' ').slice(0, 16);
  return minutes >= 120
    ? `within about ${Math.round(minutes / 60)} hours, by ${when} UTC`
    : `within about ${minutes} minute${minutes === 1 ? '' : 's'}, by ${when} UTC`;
}

export const GUARD_MESSAGES = {
  allowed: 'Veefore allowed this. The tool runs now.',
  pendingFollowed: (tool: string, expiresAt: unknown) =>
    `Veefore: "${tool}" is NOT done yet. A person must approve it in Veefore first, and has not decided yet. Once they approve it (it can be approved ${until(expiresAt)}), it is done automatically, exactly once; nothing more is needed from you or the user. If they deny it, it will not happen. Tell the user exactly this, and do not call this tool again for the same request.`,
  pending: (tool: string, expiresAt: unknown) =>
    `Veefore: "${tool}" was NOT done. A person must approve it in Veefore first, and has not decided yet. Tell the user exactly this: it is waiting for approval, and once it is approved they can ask again (it can be approved ${until(expiresAt)}). When they do, call this tool again with exactly the same arguments; it will then go ahead without a second approval.`,
  refused: (tool: string, reason: string) =>
    `Veefore refused "${tool}"${reason ? `: ${reason}` : ''}. It was NOT done. Tell the user it was not allowed and why; do not try another way to do it.`,
  denied: (tool: string) =>
    `A person denied "${tool}" in Veefore. It was NOT done. Tell the user it was not approved.`,
  expired: (tool: string) =>
    `No one approved "${tool}" in Veefore in time. It was NOT done. Tell the user it was not approved in time.`,
  unknown: (node: string) =>
    `Veefore has no tool for "${node}" for this agent, so it was NOT done. Tell the user it is not set up yet: in Veefore, Integrations → n8n, add this action for the agent with "n8n performs it".`,
  veeforePerforms: (node: string) =>
    `"${node}" is set to "Veefore performs it" in Veefore, so the Guard does not run it in n8n (that would do it twice). It was NOT done. In Veefore, switch it to "n8n performs it", or use the Veefore tool instead of the Guard.`,
  unreachable: (node: string, why: string) =>
    `Veefore could not be asked about "${node}" (${why.replace(/\.$/, '')}), so it was NOT done. Tell the user to try again in a moment.`,
};
