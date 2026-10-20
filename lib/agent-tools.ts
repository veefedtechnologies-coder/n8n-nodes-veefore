/**
 * Veefore Tools: one node that gives an AI Agent several Veefore actions.
 *
 * Each action the user picks is one of two kinds, as set in Veefore:
 *
 *  - "Veefore performs it": offered to the model with Veefore's own schema;
 *    a call goes to the gateway, which decides and performs it.
 *  - "n8n performs it": performed by an n8n tool (Gmail, Slack, …) wired into
 *    this node's n8n Tools input. The model sees that tool as usual, but a
 *    call runs it only after Veefore allows it. Tools wired in for any other
 *    reason are not offered at all.
 *
 * This file decides which tools the model is offered and how a call maps to
 * them, with no n8n imports, so it is tested on its own.
 */
import { actionOf, matchTool, toolNameOf, type GuardedNode, type VeeforeToolEntry } from './guard';

/** Picked actions are stored with their kind, so the editor can show the n8n Tools input. */
export const N8N_PERFORMS = '::n8n';
export const VEEFORE_PERFORMS = '::veefore';

export function selectionValue(tool: VeeforeToolEntry): string {
  return `${tool.key}${tool.kind === 'CLIENT' ? N8N_PERFORMS : VEEFORE_PERFORMS}`;
}

/** The tool key of a picked action (older or hand-typed values have no suffix). */
export function keyOf(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/::(?:n8n|veefore)$/, '');
}

/** The expression n8n evaluates in the editor to show the n8n Tools input. */
export const INPUTS_EXPRESSION = `={{ ((tools) => (Array.isArray(tools) && tools.some((t) => String(t).endsWith('${N8N_PERFORMS}'))) ? [{ type: 'ai_tool', displayName: 'n8n Tools' }] : [])($parameter.tools) }}`;

export function needsN8nTools(values: unknown): boolean {
  return Array.isArray(values) && values.some((value) => String(value).endsWith(N8N_PERFORMS));
}

/** A tool wired into the n8n Tools input, as n8n hands it over. */
export interface ConnectedTool {
  name: string;
  description?: string;
  schema?: unknown;
  metadata?: Record<string, unknown>;
  invoke(input: unknown): Promise<unknown>;
}

export interface JsonObjectSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export type PlanEntry =
  | {
      kind: 'veefore';
      name: string;
      description: string;
      schema: JsonObjectSchema;
      tool: VeeforeToolEntry;
    }
  | {
      kind: 'n8n';
      name: string;
      description: string;
      /** The connected tool's own schema (n8n's), passed through untouched. */
      schema: unknown;
      tool: VeeforeToolEntry;
      node: GuardedNode;
      connected: ConnectedTool;
    }
  | {
      /** An n8n-performed action with no n8n tool wired in for it: it says so. */
      kind: 'missing';
      name: string;
      description: string;
      schema: JsonObjectSchema;
      tool: VeeforeToolEntry;
    };

/** Veefore's schema, without its own `x-veefore-*` annotations, as the model sees it. */
export function modelSchema(schema: unknown): JsonObjectSchema {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key.startsWith('x-') || key === '$schema' || key === '$id') continue;
      out[key] = clean(entry);
    }
    return out;
  };
  const cleaned = (clean(schema) ?? {}) as Record<string, unknown>;
  const properties =
    cleaned.properties && typeof cleaned.properties === 'object'
      ? (cleaned.properties as Record<string, unknown>)
      : {};
  return {
    ...cleaned,
    type: 'object',
    properties,
    ...(Array.isArray(cleaned.required) ? { required: cleaned.required as string[] } : {}),
  };
}

/** A tool name the model can call: letters, digits, `_` and `-`, at most 64. */
function safeName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
  return safe || 'veefore_tool';
}

/** Which node a connected tool came from: n8n names it in the tool's metadata. */
function nodeOf(tool: ConnectedTool, nodes: GuardedNode[]): GuardedNode | null {
  const source = tool.metadata?.sourceNodeName;
  const live = nodes.filter((node) => node.disabled !== true);
  if (typeof source === 'string') return live.find((node) => node.name === source) ?? null;
  return (
    live.find((node) => toolNameOf(node.name) === tool.name || node.name === tool.name) ?? null
  );
}

export interface Plan {
  entries: PlanEntry[];
  /** For the person building the workflow: what is set up wrong, in plain words. */
  hints: string[];
}

/**
 * The tools the model is offered.
 *
 * `selected` are the picked actions; `available` the agent's tools as Veefore
 * lists them now (the kind there wins over the one stored with the pick);
 * `connected` and `nodes` the n8n tools wired in and their nodes.
 */
export function planTools(
  selected: unknown,
  available: VeeforeToolEntry[],
  connected: ConnectedTool[],
  nodes: GuardedNode[],
): Plan {
  const entries: PlanEntry[] = [];
  const hints: string[] = [];
  const used = new Set<ConnectedTool>();
  const keys = [...new Set((Array.isArray(selected) ? selected : []).map(keyOf).filter(Boolean))];

  for (const key of keys) {
    const tool = available.find((entry) => entry.key === key);
    if (!tool) {
      hints.push(
        `"${key}" is no longer one of this agent's tools in Veefore, so the model is not offered it.`,
      );
      continue;
    }
    const label = tool.name || tool.key;
    const description = String(
      (tool as { description?: unknown }).description || tool.name || tool.key,
    );
    if (tool.kind !== 'CLIENT') {
      entries.push({
        kind: 'veefore',
        name: safeName(tool.key),
        description,
        schema: modelSchema(tool.parameter_schema),
        tool,
      });
      continue;
    }
    const matching = connected.filter((candidate) => {
      const node = nodeOf(candidate, nodes);
      return node !== null && matchTool([tool], actionOf(node))?.key === tool.key;
    });
    if (matching.length === 0) {
      hints.push(
        `"${label}" is performed by n8n, but no matching n8n tool is connected to this node's n8n Tools input.`,
      );
      entries.push({
        kind: 'missing',
        name: safeName(tool.key),
        description,
        schema: modelSchema(tool.parameter_schema),
        tool,
      });
      continue;
    }
    for (const candidate of matching) {
      used.add(candidate);
      entries.push({
        kind: 'n8n',
        name: candidate.name,
        description: candidate.description || description,
        schema: candidate.schema,
        tool,
        node: nodeOf(candidate, nodes)!,
        connected: candidate,
      });
    }
  }

  for (const candidate of connected) {
    if (used.has(candidate)) continue;
    hints.push(
      `The connected tool "${nodeOf(candidate, nodes)?.name ?? candidate.name}" is not offered to the model: pick its Veefore action (set to "n8n performs it") in Actions.`,
    );
  }
  return { entries, hints };
}

/** The keys of an object schema: JSON Schema, or a zod object (n8n's tools). */
export function schemaKeys(schema: unknown): string[] | null {
  if (!schema || typeof schema !== 'object') return null;
  const record = schema as {
    properties?: unknown;
    shape?: unknown;
    _def?: { shape?: unknown };
  };
  if (record.properties && typeof record.properties === 'object')
    return Object.keys(record.properties as object);
  const shape =
    typeof record._def?.shape === 'function'
      ? (record._def.shape as () => unknown)()
      : (record.shape ?? record._def?.shape);
  if (shape && typeof shape === 'object') return Object.keys(shape as object);
  return null;
}

/** n8n merges the agent's own input (chatInput, sessionId, …) into a call: keep only the tool's arguments. */
export function argumentsFor(
  entry: PlanEntry,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const rest = { ...input };
  delete rest.tool;
  delete rest.toolCallId;
  const keys = schemaKeys(entry.schema);
  if (!keys) return rest;
  const picked: Record<string, unknown> = {};
  for (const key of keys) if (rest[key] !== undefined) picked[key] = rest[key];
  return picked;
}

export const TOOLS_MESSAGES = {
  notConnected: (label: string) =>
    `"${label}" is not set up in n8n yet, so it was NOT done. Tell the user: connect the matching n8n tool to the Veefore Tools node's n8n Tools input.`,
  unknownCall: (name: string) =>
    `There is no tool called "${name}" on this Veefore Tools node, so nothing was done.`,
};
