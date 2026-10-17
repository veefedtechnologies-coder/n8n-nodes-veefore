import type { FieldType, ResourceMapperField, ResourceMapperValue } from 'n8n-workflow';

/**
 * Turns a Veefore tool's JSON Schema into the fields n8n shows, and the
 * mapped values back into the tool's parameters.
 *
 * As a tool for an AI Agent, each field is prefilled with `$fromAI(...)`
 * carrying the parameter's name, description and type, so the model is told
 * exactly what each argument means instead of guessing a JSON blob.
 */

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  title?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

const AI_KEY = /^[a-zA-Z0-9_-]{1,64}$/;

function typeOf(schema: JsonSchema): string {
  const raw = Array.isArray(schema.type) ? schema.type.find((t) => t !== 'null') : schema.type;
  return raw ?? 'string';
}

function fieldType(schema: JsonSchema): FieldType {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return 'options';
  switch (typeOf(schema)) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return 'object';
    case 'array':
      return 'array';
    default:
      return 'string';
  }
}

function fromAiType(schema: JsonSchema): 'string' | 'number' | 'boolean' | 'json' {
  switch (typeOf(schema)) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
    case 'array':
      return 'json';
    default:
      return 'string';
  }
}

/** A `$fromAI` expression with every argument as a safe string literal. */
export function fromAiExpression(key: string, description: string, type: string): string {
  const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const oneLine = description.replace(/\s+/g, ' ').trim().slice(0, 300);
  return `={{ $fromAI(${quote(key)}, ${quote(oneLine)}, ${quote(type)}) }}`;
}

/** `due_date` / `dueDate` → `Due date`. */
export function labelFor(id: string): string {
  const words = id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

export function fieldsFromSchema(
  schema: JsonSchema,
  options: { fromAi: boolean },
): ResourceMapperField[] {
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties ?? {}).map(([id, property]) => {
    const type = fieldType(property);
    const label = property.title || labelFor(id);
    const description = property.description || label;
    const field: ResourceMapperField = {
      id,
      displayName: label,
      required: required.has(id),
      defaultMatch: false,
      canBeUsedToMatch: false,
      display: true,
      type,
    };
    if (type === 'options') {
      field.options = (property.enum ?? []).map((value) => ({
        name: String(value),
        value: value as string | number | boolean,
      }));
    }
    if (options.fromAi && AI_KEY.test(id)) {
      const allowed =
        type === 'options' ? ` One of: ${(property.enum ?? []).map(String).join(', ')}.` : '';
      field.defaultValue = fromAiExpression(id, `${description}.${allowed}`, fromAiType(property));
    }
    return field;
  });
}

/** Mapped values → tool parameters: blanks dropped, JSON fields parsed, types kept. */
export function parametersFromMapper(
  mapper: Pick<ResourceMapperValue, 'value' | 'schema'> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const types = new Map((mapper?.schema ?? []).map((field) => [field.id, field.type]));
  for (const [key, value] of Object.entries(mapper?.value ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    const type = types.get(key);
    if ((type === 'object' || type === 'array') && typeof value === 'string') {
      try {
        out[key] = JSON.parse(value);
        continue;
      } catch {
        // Sent as written; the gateway validates it against the tool's schema.
      }
    }
    if (type === 'number' && typeof value === 'string' && value.trim() !== '') {
      const number = Number(value);
      out[key] = Number.isFinite(number) ? number : value;
      continue;
    }
    if (type === 'boolean' && typeof value === 'string') {
      out[key] = value === 'true' ? true : value === 'false' ? false : value;
      continue;
    }
    out[key] = value;
  }
  return out;
}
