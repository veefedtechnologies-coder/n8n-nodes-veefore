/**
 * Veefore Tools: one node that gives an AI Agent several Veefore actions.
 *
 * Each action added to the node is one of two kinds, as set in Veefore:
 *
 *  - "Veefore performs it": offered to the model with the parameters chosen in
 *    the node. A parameter is either filled by the model (`$fromAI`, with the
 *    hint the model is given) or fixed in the node, so the model never sees
 *    it. A call goes to the gateway, which decides and performs it.
 *  - "n8n performs it": performed by an n8n tool (Gmail, Slack, …) wired into
 *    this node's n8n Tools input. The model sees that tool as usual, but a
 *    call runs it only after Veefore allows it. Tools wired in for any other
 *    reason are not offered at all.
 *
 * This file decides which tools the model is offered and how a call maps to
 * them, with no n8n imports, so it is tested on its own.
 */
import { actionOf, matchTool, toolNameOf, type GuardedNode, type VeeforeToolEntry } from './guard';
import { parametersFromMapper, type JsonSchema } from '../nodes/Veefore/schema';

/** Picked actions are stored with their kind, so the editor can show the n8n Tools input. */
export const N8N_PERFORMS = '::n8n';
export const VEEFORE_PERFORMS = '::veefore';

export function selectionValue(tool: VeeforeToolEntry): string {
  return `${tool.key}${tool.kind === 'CLIENT' ? N8N_PERFORMS : VEEFORE_PERFORMS}`;
}

/** The tool key of a picked action (hand-typed values may have no suffix). */
export function keyOf(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/::(?:n8n|veefore)$/, '');
}

/** The expression n8n evaluates in the editor to show the n8n Tools input. */
export const INPUTS_EXPRESSION = `={{ ((list) => (Array.isArray(list) && list.some((a) => String((a && a.tool) || '').endsWith('${N8N_PERFORMS}'))) ? [{ type: 'ai_tool', displayName: 'n8n Tools' }] : [])($parameter.actions && $parameter.actions.action) }}`;

export function needsN8nTools(items: unknown): boolean {
  return (
    Array.isArray(items) &&
    items.some((item) =>
      String((item as { tool?: unknown } | null)?.tool ?? '').endsWith(N8N_PERFORMS),
    )
  );
}

/** One action as set up in the node, its values already read. */
export interface ActionConfig {
  key: string;
  /** Overrides for what the model is shown. */
  name?: string;
  description?: string;
  /** Shown to approvers and recorded with every call. */
  purpose?: string;
  /** Parameter values set in the node, sent as they are; the model never sees them. */
  fixed: Record<string, unknown>;
  /**
   * Parameters the model fills, with the hint it is given (empty = Veefore's
   * own description). `null`: not set up in the node, so the model fills every
   * parameter.
   */
  model: Record<string, string> | null;
}

/** A raw action item from the node: `{ tool, toolName, toolDescription, purpose, parameters }`. */
export interface RawAction {
  tool?: unknown;
  toolName?: unknown;
  toolDescription?: unknown;
  purpose?: unknown;
  parameters?: {
    value?: Record<string, unknown> | null;
    schema?: Array<{ id: string; type?: string; removed?: boolean }>;
  } | null;
}

const FROM_AI = /\$fromAI\(\s*(['"`])((?:\\.|(?!\1).)+)\1(?:\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3)?/;
const unescape = (text: string) => text.replace(/\\(.)/g, '$1');

/**
 * Reads an action item. `evaluate(name)` returns the evaluated value of a
 * fixed parameter that is an expression (n8n evaluates it for the run).
 */
export function readAction(
  raw: RawAction,
  schema: JsonSchema | undefined,
  evaluate: (name: string) => unknown,
): ActionConfig {
  const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
  const key = keyOf(raw.tool);
  const mapper = raw.parameters;
  const config: ActionConfig = {
    key,
    ...(text(raw.toolName) ? { name: text(raw.toolName) } : {}),
    ...(text(raw.toolDescription) ? { description: text(raw.toolDescription) } : {}),
    ...(text(raw.purpose) ? { purpose: text(raw.purpose) } : {}),
    fixed: {},
    model: null,
  };
  if (!mapper || !mapper.value || typeof mapper.value !== 'object') return config;

  const removed = new Set((mapper.schema ?? []).filter((f) => f.removed).map((f) => f.id));
  const model: Record<string, string> = {};
  const fixedRaw: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(mapper.value)) {
    if (removed.has(name)) continue;
    if (value === undefined || value === null || value === '') {
      model[name] = '';
      continue;
    }
    if (typeof value === 'string' && value.startsWith('=')) {
      const fromAi = FROM_AI.exec(value);
      if (fromAi) {
        model[name] = unescape(fromAi[4] ?? '');
        continue;
      }
      fixedRaw[name] = evaluate(name);
      continue;
    }
    fixedRaw[name] = value;
  }
  // A required parameter nobody set is still asked of the model.
  for (const name of schema?.required ?? []) {
    if (!(name in model) && !(name in fixedRaw)) model[name] = '';
  }
  config.fixed = parametersFromMapper(
    { value: fixedRaw as never, schema: mapper.schema as never },
    schema,
  );
  config.model = model;
  return config;
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

interface EntryBase {
  name: string;
  description: string;
  tool: VeeforeToolEntry;
  config: ActionConfig;
}

export type PlanEntry =
  | (EntryBase & { kind: 'veefore'; schema: JsonObjectSchema })
  | (EntryBase & {
      kind: 'n8n';
      /** The connected tool's own schema (n8n's), passed through untouched. */
      schema: unknown;
      node: GuardedNode;
      connected: ConnectedTool;
    })
  /** An n8n-performed action with no n8n tool wired in for it: it says so. */
  | (EntryBase & { kind: 'missing'; schema: JsonObjectSchema });

/** Veefore's schema without its own `x-veefore-*` annotations, as the model sees it. */
export function modelSchema(
  schema: unknown,
  model?: Record<string, string> | null,
): JsonObjectSchema {
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
  let properties =
    cleaned.properties && typeof cleaned.properties === 'object'
      ? (cleaned.properties as Record<string, Record<string, unknown>>)
      : {};
  let required = Array.isArray(cleaned.required) ? (cleaned.required as string[]) : undefined;
  if (model) {
    const picked: Record<string, Record<string, unknown>> = {};
    for (const [name, hint] of Object.entries(model)) {
      const base = properties[name] ?? { type: 'string' };
      picked[name] = hint ? { ...base, description: hint } : base;
    }
    properties = picked;
    required = required?.filter((name) => name in picked);
  }
  return {
    ...cleaned,
    type: 'object',
    properties,
    ...(required && required.length > 0 ? { required } : { required: undefined }),
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
 * `actions` are the actions set up in the node; `available` the agent's
 * tools as Veefore lists them now (the kind there wins over the one stored
 * with the pick); `connected` and `nodes` the n8n tools wired in and their nodes.
 */
export function planTools(
  actions: ActionConfig[],
  available: VeeforeToolEntry[],
  connected: ConnectedTool[],
  nodes: GuardedNode[],
): Plan {
  const entries: PlanEntry[] = [];
  const hints: string[] = [];
  const used = new Set<ConnectedTool>();
  const names = new Set<string>();
  const unique = (name: string) => {
    let candidate = name;
    for (let n = 2; names.has(candidate); n += 1) candidate = safeName(`${name}_${n}`);
    names.add(candidate);
    return candidate;
  };

  for (const config of actions) {
    if (!config.key) continue;
    const tool = available.find((entry) => entry.key === config.key);
    if (!tool) {
      hints.push(
        `"${config.key}" is no longer one of this agent's tools in Veefore, so the model is not offered it.`,
      );
      continue;
    }
    const label = tool.name || tool.key;
    const description =
      config.description ||
      String((tool as { description?: unknown }).description || tool.name || tool.key);
    if (tool.kind !== 'CLIENT') {
      entries.push({
        kind: 'veefore',
        name: unique(safeName(config.name || tool.key)),
        description,
        schema: modelSchema(tool.parameter_schema, config.model),
        tool,
        config,
      });
      continue;
    }
    const matching = connected.filter((candidate) => {
      if (used.has(candidate)) return false;
      const node = nodeOf(candidate, nodes);
      return node !== null && matchTool([tool], actionOf(node))?.key === tool.key;
    });
    if (matching.length === 0) {
      hints.push(
        `"${label}" is performed by n8n, but no matching n8n tool is connected to this node's n8n Tools input.`,
      );
      entries.push({
        kind: 'missing',
        name: unique(safeName(config.name || tool.key)),
        description,
        schema: modelSchema({ type: 'object', properties: {} }),
        tool,
        config,
      });
      continue;
    }
    for (const candidate of matching) {
      used.add(candidate);
      entries.push({
        kind: 'n8n',
        name: unique(config.name ? safeName(config.name) : candidate.name),
        description: config.description || candidate.description || description,
        schema: candidate.schema,
        tool,
        config,
        node: nodeOf(candidate, nodes)!,
        connected: candidate,
      });
    }
  }

  for (const candidate of connected) {
    if (used.has(candidate)) continue;
    hints.push(
      `The connected tool "${nodeOf(candidate, nodes)?.name ?? candidate.name}" is not offered to the model: add its Veefore action (set to "n8n performs it") under Actions.`,
    );
  }
  return { entries, hints };
}

/** The keys of an object schema: JSON Schema, or a zod object (n8n's tools). */
export function schemaKeys(schema: unknown): string[] | null {
  if (!schema || typeof schema !== 'object') return null;
  const record = schema as { properties?: unknown; shape?: unknown; _def?: { shape?: unknown } };
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

/** What Veefore is asked to run for a Veefore-performed call: the model's arguments and the fixed values. */
export function parametersFor(
  entry: PlanEntry,
  args: Record<string, unknown>,
): Record<string, unknown> {
  return { ...args, ...entry.config.fixed };
}

export const TOOLS_MESSAGES = {
  notConnected: (label: string) =>
    `"${label}" is not set up in n8n yet, so it was NOT done. Tell the user: connect the matching n8n tool to the Veefore Tools node's n8n Tools input.`,
  unknownCall: (name: string) =>
    `There is no tool called "${name}" on this Veefore Tools node, so nothing was done.`,
};
