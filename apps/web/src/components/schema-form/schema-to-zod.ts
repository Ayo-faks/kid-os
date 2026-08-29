// Runtime JSON-Schema → Zod converter for CareOS form templates.
//
// Intentionally covers only the subset our v1 templates use. The aim is
// type/format/enum/length validation at the field level so the user gets
// immediate feedback as they type; *missing required* is handled separately
// via `getMissingMandatoryFields` from @careos/schemas because the workflow
// permits saving drafts with required fields still blank.

import type { JsonSchema } from '@careos/schemas/runtime';
import { z, type ZodType } from 'zod';

export interface JsonSchemaToZodOptions {
  /** When true, top-level required fields produce required Zod fields. Draft mode = false. */
  readonly enforceRequired?: boolean;
}

export function jsonSchemaToZod(
  schema: JsonSchema,
  options: JsonSchemaToZodOptions = {},
): ZodType<Record<string, unknown>, Record<string, unknown>> {
  return build(schema, options.enforceRequired ?? false) as ZodType<
    Record<string, unknown>,
    Record<string, unknown>
  >;
}

function build(schema: JsonSchema, enforceRequired: boolean): ZodType {
  switch (schema.type) {
    case 'string':
      return buildString(schema);
    case 'boolean':
      return z.boolean();
    case 'number':
    case 'integer':
      return z.number();
    case 'array':
      return buildArray(schema, enforceRequired);
    case 'object':
      return buildObject(schema, enforceRequired);
    default:
      return z.unknown();
  }
}

function buildString(schema: JsonSchema): ZodType {
  if (schema.enum && schema.enum.length > 0) {
    const values = schema.enum.filter((v): v is string => typeof v === 'string');
    if (values.length === schema.enum.length && values.length > 0) {
      return z.enum(values as [string, ...string[]]);
    }
  }

  let s = z.string();
  if (schema.format === 'uuid') s = s.uuid();
  if (schema.format === 'date-time') s = s.datetime({ offset: true });
  if (typeof schema.minLength === 'number') s = s.min(schema.minLength);
  if (typeof schema.maxLength === 'number') s = s.max(schema.maxLength);
  return s;
}

function buildArray(schema: JsonSchema, enforceRequired: boolean): ZodType {
  const items = schema.items ? build(schema.items, enforceRequired) : z.unknown();
  let arr = z.array(items);
  if (typeof schema.minItems === 'number') arr = arr.min(schema.minItems);
  if (typeof schema.maxItems === 'number') arr = arr.max(schema.maxItems);
  return arr;
}

function buildObject(schema: JsonSchema, enforceRequired: boolean): ZodType {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const shape: Record<string, ZodType> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const child = build(propSchema, enforceRequired);
    shape[key] = enforceRequired && required.has(key) ? child : child.optional();
  }

  return z.object(shape);
}
