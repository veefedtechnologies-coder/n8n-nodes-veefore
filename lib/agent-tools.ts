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
import type { ResourceMapperField } from 'n8n-workflow';
import {
  fieldsFromSchema,
  fromAiExpression,
  parametersFromMapper,
  type JsonSchema,
} from '../nodes/Veefore/schema';

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
export const INPUTS_EXPRESSION = `={{ ((list) => (Array.isArray(list) && list.some((a) => ((t) => t.endsWith('::n8n') || t.endsWith('::mixed'))(String((a && a.tool) || '')))) ? [{ type: 'ai_tool', displayName: 'n8n Tools' }] : [])($parameter.app ? [{ tool: $parameter.app }] : $parameter.actions ? $parameter.actions.action : [{ tool: $parameter.tool }]) }}`;

/**
 * Version 3's check, made by the editor as it shows the app's settings:
 * `stale` when the Fields hold another app's list (the app was changed). The
 * Actions and Fields then hide, so n8n clears them, and show again, loading
 * the new app's. Anything that fails to resolve keeps them shown.
 *
 * It must not name the node's later settings (`app` + `Fields` is built, not
 * written): the editor resolves an expression that names one only after it,
 * with its values, and a ✨ value among them fails the whole check.
 */
export const APP_CHECK_EXPRESSION = `={{ ((list, picked) => { const schema = list && Array.isArray(list.schema) ? list.schema : []; const id = String(picked || '').replace(/::(?:n8n|veefore|mixed)$/, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'app'; return schema.every((field) => String((field && field.id) || '').startsWith(id + '__')) ? 'ok' : 'stale'; })($parameter['app' + 'Fields'], $parameter.app) }}`;

/** Version 1: how many actions; version 2: which one. */
export const SUBTITLE_EXPRESSION = `={{ $parameter.app ? String($parameter.app).replace(/::(?:n8n|veefore|mixed)$/, "") : $parameter.actions ? (($parameter.actions.action || []).length + " action(s)") : String($parameter.tool || "").replace(/::(?:n8n|veefore)$/, "").replace(/_/g, " ") }}`;

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
  /** Purpose left to the model: the hint it is given. It sends it with each call. */
  purposeFromModel?: string;
  /** Added to the tool's description: how to use this app's actions. */
  instructions?: string;
}

/** The argument a model fills with its purpose, when Purpose is left to it. */
export const PURPOSE_ARGUMENT = 'veefore_purpose';

/** A raw action item from the node: `{ tool, toolName, toolDescription, purpose, parameters }`. */
export interface RawAction {
  tool?: unknown;
  /** `auto` (Veefore's description) or `manual` (`toolDescription`). Absent before 3.3.0. */
  descriptionType?: unknown;
  toolDescription?: unknown;
  purpose?: unknown;
  actionOptions?: { toolName?: unknown } | null;
  /** Saved by 3.0.0–3.2.0 next to the other settings. Read when plain text. */
  toolName?: unknown;
  /** Saved by 3.2.0: a list of picked fields, `name` is `<tool key>::<field>`. Still read. */
  fields?: { field?: Array<{ name?: unknown; value?: unknown }> | null } | null;
  /** The action's fields (n8n's field mapper): each one ✨ (the model) or a value set here. */
  parameters?: {
    value?: Record<string, unknown> | null;
    schema?: Array<{ id: string; type?: string; removed?: boolean }>;
  } | null;
}

/** A field picked in the node, as stored: `send_message::to`. */
export const FIELD_SEPARATOR = '::';
export function fieldValue(toolKey: string, field: string): string {
  return `${toolKey}${FIELD_SEPARATOR}${field}`;
}

/** The field a stored pick names, when it belongs to this action (or names no action). */
export function fieldKeyOf(stored: string, toolKey: string): string | null {
  const at = stored.lastIndexOf(FIELD_SEPARATOR);
  if (at < 0) return stored.trim() || null;
  return stored.slice(0, at) === toolKey ? stored.slice(at + FIELD_SEPARATOR.length) || null : null;
}

function typeOfProperty(property: JsonSchema | undefined): string {
  const raw = Array.isArray(property?.type)
    ? property?.type.find((t) => t !== 'null')
    : property?.type;
  if (raw === 'integer' || raw === 'number') return 'number';
  if (raw === 'boolean' || raw === 'object' || raw === 'array') return raw;
  return 'string';
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
  options: {
    /**
     * Fields the mapper does not list (or lists for another action of the
     * app) are the model's, with Veefore's own description (version 3).
     */
    unlistedToModel?: boolean;
  } = {},
): ActionConfig {
  // Name and description are set by a person. An expression here is n8n's
  // own "let the model fill it" override (saved by older versions of this
  // node): ignored, so the model never names or describes its own tool. The
  // purpose's expressions are read below.
  const text = (value: unknown) =>
    typeof value === 'string' && !value.trim().startsWith('=') ? value.trim() : '';
  const key = keyOf(raw.tool);
  const mapper = raw.parameters;
  const toolName = text(raw.actionOptions?.toolName) || text(raw.toolName);
  // Before 3.3.0 there was no choice: a description written in was used.
  const manual =
    raw.descriptionType === 'manual' ||
    (raw.descriptionType === undefined && text(raw.toolDescription) !== '');
  const description = manual ? text(raw.toolDescription) : '';
  const config: ActionConfig = {
    key,
    ...(toolName ? { name: toolName } : {}),
    ...(description ? { description } : {}),
    ...(text(raw.purpose) ? { purpose: text(raw.purpose) } : {}),
    fixed: {},
    model: null,
  };
  // Purpose left to the model ("Defined automatically by the model"): the
  // model says why, per call, and approvers see it. Any other expression is
  // the person's, evaluated for the run.
  if (typeof raw.purpose === 'string' && raw.purpose.trim().startsWith('=')) {
    const fromAi = FROM_AI.exec(raw.purpose);
    if (fromAi) {
      config.purposeFromModel = unescape(fromAi[4] ?? '');
    } else {
      let value: unknown;
      try {
        value = evaluate('purpose');
      } catch {
        // An expression that cannot be resolved here sets no purpose.
      }
      if (typeof value === 'string' && value.trim()) config.purpose = value.trim();
    }
  }

  // The field mapper wins: a 3.2.0 Fields list may linger, hidden, next to it.
  const mapped =
    mapper?.value && typeof mapper.value === 'object' && Object.keys(mapper.value).length > 0;
  // 3.2.0's Fields list: each one the model fills (with its hint) or a value set here.
  const entries = (!mapped && Array.isArray(raw.fields?.field) ? raw.fields.field : []).filter(
    (entry): entry is { name: string; value?: unknown } =>
      typeof entry?.name === 'string' && fieldKeyOf(entry.name, key) !== null,
  );
  if (entries.length > 0) {
    const properties = Object.keys(schema?.properties ?? {});
    const model: Record<string, string> = Object.fromEntries(properties.map((name) => [name, '']));
    const fixedRaw: Record<string, unknown> = {};
    entries.forEach((entry, index) => {
      const name = fieldKeyOf(entry.name, key)!;
      const value = entry.value;
      if (typeof value === 'string' && value.trim().startsWith('=')) {
        const fromAi = FROM_AI.exec(value);
        if (fromAi) {
          model[name] = unescape(fromAi[4] ?? '');
          return;
        }
        fixedRaw[name] = evaluate(`fields.field[${index}].value`);
      } else if (value !== undefined && value !== null && value !== '') {
        fixedRaw[name] = value;
      } else {
        return;
      }
      delete model[name];
    });
    config.fixed = parametersFromMapper(
      {
        value: fixedRaw as never,
        schema: Object.keys(fixedRaw).map((id) => ({
          id,
          type: typeOfProperty(schema?.properties?.[id]),
        })) as never,
      },
      schema,
    );
    config.model = properties.length > 0 ? model : null;
    return config;
  }

  if (!mapper || !mapper.value || typeof mapper.value !== 'object') return config;

  if (options.unlistedToModel) {
    const properties = schema?.properties ?? {};
    const model: Record<string, string> = Object.fromEntries(
      Object.keys(properties).map((name) => [name, '']),
    );
    const fixedRaw: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(mapper.value)) {
      // A field of another of the app's actions.
      if (!(name in properties)) continue;
      if (value === undefined || value === null || value === '') continue;
      if (typeof value === 'string' && value.trim().startsWith('=')) {
        const fromAi = FROM_AI.exec(value);
        if (fromAi) {
          model[name] = unescape(fromAi[4] ?? '');
          continue;
        }
        fixedRaw[name] = evaluate(`parameters.value.${name}`);
      } else {
        fixedRaw[name] = value;
      }
      delete model[name];
    }
    config.fixed = parametersFromMapper(
      {
        value: fixedRaw as never,
        schema: Object.keys(fixedRaw).map((id) => ({
          id,
          type: typeOfProperty(properties[id]),
        })) as never,
      },
      schema,
    );
    config.model = Object.keys(properties).length > 0 ? model : null;
    return config;
  }

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
      fixedRaw[name] = evaluate(`parameters.value.${name}`);
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
  options: {
    /**
     * An action n8n performs with no n8n tool wired in is still offered, and
     * says so when called (versions 1 and 2). Version 3 offers only what can run.
     */
    offerMissing?: boolean;
  } = {},
): Plan {
  const offerMissing = options.offerMissing !== false;
  const told = (text: string, config: ActionConfig) =>
    config.instructions ? `${text}\n\n${config.instructions}`.slice(0, 2000) : text;
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
        description: told(description, config),
        schema: withPurposeArgument(modelSchema(tool.parameter_schema, config.model), config),
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
      if (!offerMissing) continue;
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
        description: told(config.description || candidate.description || description, config),
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
  const rest = { ...args };
  delete rest[PURPOSE_ARGUMENT];
  return { ...rest, ...entry.config.fixed };
}

/** The purpose for a call: set in the node, else what the model said, if it was asked. */
export function purposeFor(entry: PlanEntry, args: Record<string, unknown>): string | undefined {
  if (entry.config.purpose) return entry.config.purpose;
  const said = args[PURPOSE_ARGUMENT];
  return typeof said === 'string' && said.trim() ? said.trim().slice(0, 500) : undefined;
}

/** Adds the purpose argument when Purpose is left to the model. Optional for the model. */
function withPurposeArgument(schema: JsonObjectSchema, config: ActionConfig): JsonObjectSchema {
  if (config.purpose || config.purposeFromModel === undefined) return schema;
  return {
    ...schema,
    properties: {
      ...schema.properties,
      [PURPOSE_ARGUMENT]: {
        type: 'string',
        description:
          config.purposeFromModel ||
          'Why you are taking this action, in one sentence. Shown to the person who approves it.',
      },
    },
  };
}

export const TOOLS_MESSAGES = {
  notConnected: (label: string) =>
    `"${label}" is not set up in n8n yet, so it was NOT done. Tell the user: connect the matching n8n tool to the Veefore Tools node's n8n Tools input.`,
  unknownCall: (name: string) =>
    `There is no tool called "${name}" on this Veefore Tools node, so nothing was done.`,
};

// ---------------------------------------------------------------------------
// Version 3: one app per node
// ---------------------------------------------------------------------------

/** An app as the node offers it: its name, its actions, who performs them. */
export interface AgentApp {
  id: string;
  name: string;
  performer: 'veefore' | 'n8n' | 'mixed';
  tools: VeeforeToolEntry[];
}

/** An app's name as its id: `WhatsApp Business Cloud` → `whatsappbusinesscloud` (as Veefore's). */
export function appIdOf(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'app';
}

/** A tool's app: as the gateway lists it, else from its name (`Send message (WhatsApp)`). */
export function appOfEntry(tool: VeeforeToolEntry): { id: string; name: string; action: string } {
  const stripped = (tool.name || tool.key).replace(/\s*\([^()]+\)\s*$/, '').trim();
  if (tool.app?.name) {
    return {
      id: tool.app.id || appIdOf(tool.app.name),
      name: tool.app.name,
      action: tool.app.action || stripped || tool.key,
    };
  }
  const named = /\(([^()]+)\)\s*$/.exec(tool.name ?? '')?.[1]?.trim();
  const name = named || tool.name || tool.key;
  return { id: appIdOf(name), name, action: named ? stripped : tool.name || tool.key };
}

/** The agent's tools, app by app, in the order Veefore lists them. */
export function groupApps(tools: VeeforeToolEntry[]): AgentApp[] {
  const apps = new Map<string, AgentApp>();
  for (const tool of tools) {
    const { id, name } = appOfEntry(tool);
    const app = apps.get(id) ?? { id, name, performer: 'veefore' as const, tools: [] };
    app.tools.push(tool);
    apps.set(id, app);
  }
  for (const app of apps.values()) {
    const n8n = app.tools.filter((tool) => tool.kind === 'CLIENT').length;
    app.performer = n8n === 0 ? 'veefore' : n8n === app.tools.length ? 'n8n' : 'mixed';
  }
  return [...apps.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** How a picked app is stored: its name and who performs it, so the editor knows the inputs. */
export function appValue(app: Pick<AgentApp, 'name' | 'performer'>): string {
  return `${app.name}::${app.performer}`;
}

/** The app a stored pick names (its id), and who performed it when picked. */
export function appOfValue(value: unknown): { id: string; name: string } | null {
  const text = String(value ?? '').trim();
  if (!text || text.startsWith('=')) return null;
  const name = text.replace(/::(?:n8n|veefore|mixed)$/, '');
  return name ? { id: appIdOf(name), name } : null;
}

/** The tools of the picked app. */
export function appTools(tools: VeeforeToolEntry[], value: unknown): VeeforeToolEntry[] {
  const picked = appOfValue(value);
  return picked ? tools.filter((tool) => appOfEntry(tool).id === picked.id) : [];
}

/**
 * The actions left to the model (n8n's ✨, "Defined automatically by the
 * model"): it may use every action of the app, as when none are picked.
 */
export const AUTO_ACTIONS = fromAiExpression('Actions', '', 'string', true);

/** The purpose's default: the model says why with each call. */
export const AUTO_PURPOSE = fromAiExpression(
  'Purpose',
  'Why you are taking this action, in one sentence. Shown to the person who approves it.',
  'string',
  true,
);

/**
 * Which of the app's actions the model may use: all of them (✨, or none
 * chosen), with the hint written under ✨; or the ones chosen.
 */
export function actionsChoice(
  raw: unknown,
  evaluate: () => unknown = () => undefined,
): { all: true; hint: string } | { all: false; keys: string[] } {
  let value = raw;
  if (typeof value === 'string' && value.trim().startsWith('=')) {
    const fromAi = FROM_AI.exec(value);
    if (fromAi) return { all: true, hint: unescape(fromAi[4] ?? '') };
    value = evaluate();
  }
  const keys = (Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [])
    .map((key) => String(key).trim())
    .filter(Boolean);
  return keys.length > 0 ? { all: false, keys } : { all: true, hint: '' };
}

/**
 * The picked actions, in the app's order. Picks that are all another app's
 * (the node's app was changed since) say nothing about this one: all of it.
 */
export function chosenTools(
  tools: VeeforeToolEntry[],
  choice: ReturnType<typeof actionsChoice>,
): { tools: VeeforeToolEntry[]; foreign: boolean } {
  if (choice.all) return { tools, foreign: false };
  const picked = tools.filter((tool) => choice.keys.includes(tool.key));
  return picked.length > 0 ? { tools: picked, foreign: false } : { tools, foreign: true };
}

/**
 * A Fields id: the app's id, then the field's name. A list loaded for another
 * app (the node's app was changed since) then never mixes with this one, and
 * n8n's refresh starts it afresh.
 */
export const APP_FIELD_SEPARATOR = '__';
export function appFieldId(appId: string, name: string): string {
  return `${appId}${APP_FIELD_SEPARATOR}${name}`;
}

/** The field a Fields id names, when it is this app's. */
export function appFieldName(appId: string, id: string): string | null {
  const prefix = `${appId}${APP_FIELD_SEPARATOR}`;
  return appId && id.startsWith(prefix) ? id.slice(prefix.length) || null : null;
}

/** This app's Fields, by field name; another app's are dropped. */
function scopedFields(mapper: RawAction['parameters'], appId: string): RawAction['parameters'] {
  if (!mapper || !mapper.value || typeof mapper.value !== 'object') return mapper;
  const value: Record<string, unknown> = {};
  for (const [id, entry] of Object.entries(mapper.value)) {
    const name = appFieldName(appId, id);
    if (name !== null) value[name] = entry;
  }
  const schema = (mapper.schema ?? []).flatMap((field) => {
    const name = appFieldName(appId, field.id);
    return name === null ? [] : [{ ...field, id: name }];
  });
  return { ...mapper, value, schema };
}

/** `WhatsApp Business Cloud` → `whatsapp_business_cloud`: a tool name's lead. */
export function appSlug(name: string): string {
  let slug = '';
  for (const word of name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)) {
    const next = slug ? `${slug}_${word}` : word;
    if (next.length > 24) break;
    slug = next;
  }
  return slug;
}

/** A Veefore action's tool name, led by its app, so an agent with several apps tells them apart. */
export function appToolName(app: string, key: string): string {
  const slug = appSlug(app);
  return !slug || key === slug || key.startsWith(`${slug}_`) ? key : `${slug}_${key}`;
}

/**
 * The app's Fields: each field of the app's actions once, required ones
 * listed (✨ by default) and the rest under "Add field", left to the model
 * until added. A field only some actions have says which. Ids are led by the
 * app's id (`appFieldId`).
 */
export function appFieldsFor(
  tools: VeeforeToolEntry[],
  appId: string = tools[0] ? appOfEntry(tools[0]).id : 'app',
): ResourceMapperField[] {
  const merged = new Map<
    string,
    { field: ResourceMapperField; usedBy: string[]; required: boolean }
  >();
  for (const tool of tools) {
    const action = appOfEntry(tool).action;
    const fields = fieldsFromSchema((tool.parameter_schema ?? {}) as JsonSchema, {
      fromAi: true,
      override: true,
      choicesAsText: true,
    });
    for (const field of fields) {
      const seen = merged.get(field.id);
      if (seen) {
        seen.usedBy.push(action);
        seen.required = seen.required || field.required;
        continue;
      }
      merged.set(field.id, { field: { ...field }, usedBy: [action], required: field.required });
    }
  }
  const several = tools.length > 1;
  return [...merged.values()]
    .map(({ field, usedBy, required }) => ({
      ...field,
      id: appFieldId(appId, field.id),
      // A field only one of several actions has says which, briefly.
      displayName:
        several && usedBy.length === 1 ? `${field.displayName} (${usedBy[0]})` : field.displayName,
      required,
      removed: !required,
    }))
    .sort((a, b) => Number(b.required) - Number(a.required));
}

/**
 * Version 3's actions as configs: the picked actions of the app, each with
 * the app's Fields (a value set there fixes that field for every action that
 * has it; anything else is the model's), the purpose and the ✨ hint. Fields
 * and picks left from another app (the node's app was changed) are ignored.
 */
export function appConfigs(
  input: {
    app: unknown;
    actions: unknown;
    fields: RawAction['parameters'];
    purpose: unknown;
  },
  available: VeeforeToolEntry[],
  evaluate: (name: string) => unknown,
): { raw: RawAction[]; configs: ActionConfig[]; tools: VeeforeToolEntry[]; hints: string[] } {
  const app = appOfValue(input.app);
  const tools = appTools(available, input.app);
  const choice = actionsChoice(input.actions, () => evaluate('actions'));
  const { tools: picked, foreign } = chosenTools(tools, choice);
  const hints =
    foreign && tools.length > 0
      ? [
          `The actions picked in this node are not ${app?.name ?? 'this app'}'s (was the app changed?), so the model may use all of its actions. Pick them again to limit it.`,
        ]
      : [];
  const instructions = choice.all ? choice.hint.trim() : '';
  const fields = scopedFields(input.fields, app?.id ?? '');
  const raw: RawAction[] = picked.map((tool) => ({
    tool: selectionValue(tool),
    parameters: tool.kind === 'CLIENT' ? null : fields,
    purpose: input.purpose,
    descriptionType: 'auto',
  }));
  // A field's value is read under its Fields id.
  const fieldPath = (name: string) =>
    name.replace(
      /^parameters\.value\.(.+)$/s,
      (_match, field: string) => `parameters.value.${appFieldId(app?.id ?? '', field)}`,
    );
  const configs = picked.map((tool, index) => {
    const config = readAction(
      raw[index]!,
      tool.parameter_schema as JsonSchema | undefined,
      (name) => evaluate(fieldPath(name)),
      { unlistedToModel: true },
    );
    if (tool.kind !== 'CLIENT') config.name = appToolName(appOfEntry(tool).name, tool.key);
    if (instructions) config.instructions = instructions;
    return config;
  });
  return { raw, configs, tools: picked, hints };
}
