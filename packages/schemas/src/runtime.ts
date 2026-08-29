export type ActorKind = 'user' | 'agent' | 'system';

export interface JsonSchema {
  readonly $id?: string;
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: string;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly default?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly format?: string;
  readonly allOf?: readonly JsonSchema[];
  readonly if?: JsonSchema;
  readonly then?: JsonSchema;
  readonly else?: JsonSchema;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly 'x-mandatory'?: boolean;
}

export interface UiSchema {
  readonly $id?: string;
  readonly order?: readonly string[];
  readonly widgets?: Readonly<Record<string, UiWidget>>;
  readonly sections?: readonly UiSection[];
}

export interface UiWidget {
  readonly widget: string;
  readonly placeholder?: string;
  readonly rows?: number;
  readonly emphasis?: 'danger' | 'warning' | 'info';
  readonly visibleWhen?: { readonly field: string; readonly equals: unknown };
}

export interface UiSection {
  readonly title: string;
  readonly fields: readonly string[];
}

export function getMissingMandatoryFields(
  schema: JsonSchema,
  formData: Readonly<Record<string, unknown>> | undefined,
  pathPrefix = '',
): string[] {
  const missing: string[] = [];
  if (schema.type !== 'object' || !schema.properties) return missing;

  const data = formData ?? {};
  const requiredSet = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(schema.properties)) {
    const path = pathPrefix ? `${pathPrefix}.${key}` : key;
    const isMandatory = propSchema['x-mandatory'] === true || requiredSet.has(key);
    const value = data[key];

    if (isMandatory && isEmpty(value)) {
      missing.push(path);
      continue;
    }

    if (propSchema.type === 'object' && propSchema.properties && isPlainObject(value)) {
      missing.push(...getMissingMandatoryFields(propSchema, value, path));
    }
  }

  return missing;
}

function isEmpty(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
