// JSON Schema catalogue for schema-driven forms (incidents, handovers, notes).
//
// Each entry below points at a versioned `<id>.<version>.schema.json` and
// matching `<id>.<version>.ui.json` under `../schemas/`. Consumers load them
// via `loadFormTemplate(id, version)` which reads from disk; this keeps the
// package usable as a plain workspace dep without bundler tricks.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { FormatsPlugin } from 'ajv-formats';
import * as addFormatsModule from 'ajv-formats';

export const SCHEMAS_VERSION = '1.0.0' as const;

export type ActorKind = 'user' | 'agent' | 'system';

export interface FormTemplateRef {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly schemaPath: string;
  readonly uiPath: string;
}

// JSON Schema (Draft 2020-12) — we type the fields we touch and treat the rest
// as opaque. A full Draft 2020-12 type would balloon this file; keep it tight.
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

const SCHEMAS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

function ref(id: string, version: string, title: string): FormTemplateRef {
  return {
    id,
    version,
    title,
    schemaPath: resolve(SCHEMAS_DIR, `${id}.${version}.schema.json`),
    uiPath: resolve(SCHEMAS_DIR, `${id}.${version}.ui.json`),
  };
}

export const FORM_TEMPLATES: readonly FormTemplateRef[] = Object.freeze([
  ref('incident.behavioural', 'v1', 'Behavioural Incident'),
  ref('incident.safeguarding', 'v1', 'Safeguarding Incident'),
  ref('incident.medication-near-miss', 'v1', 'Medication Near-Miss'),
  ref('handover.shift-end', 'v1', 'Shift-End Handover'),
  ref('note.observation', 'v1', 'Observation Note'),
  ref('comms.email-draft', 'v1', 'Email Draft'),
]);

export function findFormTemplate(id: string, version = 'v1'): FormTemplateRef | undefined {
  return FORM_TEMPLATES.find((t) => t.id === id && t.version === version);
}

export interface LoadedFormTemplate {
  readonly ref: FormTemplateRef;
  readonly schema: JsonSchema;
  readonly uiSchema: UiSchema;
}

export interface SchemaValidationError {
  /** RFC 6901 JSON Pointer into the submitted form data. */
  readonly path: string;
  readonly message: string;
}

export interface FormDataValidationResult {
  readonly valid: boolean;
  readonly missingMandatory: readonly string[];
  readonly errors: readonly SchemaValidationError[];
}

const loadedTemplateCache = new Map<string, LoadedFormTemplate>();
const validatorCache = new Map<string, ValidateFunction<unknown>>();
const partialValidatorCache = new Map<string, ValidateFunction<unknown>>();
const ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false });
const addFormats = addFormatsModule.default as unknown as FormatsPlugin;
addFormats(ajv);
ajv.addKeyword({ keyword: 'x-mandatory', schemaType: 'boolean', valid: true });

export function loadFormTemplate(id: string, version = 'v1'): LoadedFormTemplate {
  const cacheKey = `${id}@${version}`;
  const cached = loadedTemplateCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const r = findFormTemplate(id, version);
  if (!r) {
    throw new Error(`Unknown form template: ${id}@${version}`);
  }
  const schema = JSON.parse(readFileSync(r.schemaPath, 'utf8')) as JsonSchema;
  const uiSchema = JSON.parse(readFileSync(r.uiPath, 'utf8')) as UiSchema;
  const loaded = { ref: r, schema, uiSchema };
  loadedTemplateCache.set(cacheKey, loaded);
  return loaded;
}

export function validateFormData(
  templateId: string,
  version: string,
  formData: unknown,
): FormDataValidationResult {
  const template = loadFormTemplate(templateId, version);
  const validate = compiledValidator(template);
  const ajvValid = validate(formData);
  const errors = normalizeErrors(validate.errors ?? []);
  const record = isPlainObject(formData) ? formData : undefined;
  const missingMandatory = new Set(getMissingMandatoryFields(template.schema, record));

  for (const error of validate.errors ?? []) {
    if (error.keyword === 'required') {
      const missingProperty = readStringParameter(error.params, 'missingProperty');
      if (missingProperty !== undefined) {
        missingMandatory.add(pointerToDotted(appendPointer(error.instancePath, missingProperty)));
      }
    }
  }

  return {
    errors,
    missingMandatory: [...missingMandatory],
    valid: ajvValid && missingMandatory.size === 0,
  };
}

export function validatePartialFormData(
  templateId: string,
  version: string,
  formData: unknown,
): FormDataValidationResult {
  const template = loadFormTemplate(templateId, version);
  const validate = compiledPartialValidator(template);
  const valid = validate(formData);
  const record = isPlainObject(formData) ? formData : undefined;

  return {
    errors: normalizeErrors(validate.errors ?? []),
    missingMandatory: getMissingMandatoryFields(template.schema, record),
    valid,
  };
}

function compiledValidator(template: LoadedFormTemplate): ValidateFunction<unknown> {
  const cacheKey = `${template.ref.id}@${template.ref.version}`;
  const cached = validatorCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const validate = ajv.compile(template.schema as AnySchema);
  validatorCache.set(cacheKey, validate);
  return validate;
}

function compiledPartialValidator(template: LoadedFormTemplate): ValidateFunction<unknown> {
  const cacheKey = `${template.ref.id}@${template.ref.version}`;
  const cached = partialValidatorCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const validate = ajv.compile(withoutRequiredKeywords(template.schema) as AnySchema);
  partialValidatorCache.set(cacheKey, validate);
  return validate;
}

function withoutRequiredKeywords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutRequiredKeywords);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'required' || key === '$id') {
      continue;
    }
    result[key] = withoutRequiredKeywords(child);
  }
  return result;
}

function normalizeErrors(errors: readonly ErrorObject[]): SchemaValidationError[] {
  return errors.map((error) => ({
    message: error.message ?? `Failed ${error.keyword} validation.`,
    path: errorPointer(error),
  }));
}

function errorPointer(error: ErrorObject): string {
  if (error.keyword === 'required') {
    const property = readStringParameter(error.params, 'missingProperty');
    return property === undefined
      ? pointerOrRoot(error.instancePath)
      : appendPointer(error.instancePath, property);
  }
  if (error.keyword === 'additionalProperties') {
    const property = readStringParameter(error.params, 'additionalProperty');
    return property === undefined
      ? pointerOrRoot(error.instancePath)
      : appendPointer(error.instancePath, property);
  }
  return pointerOrRoot(error.instancePath);
}

function readStringParameter(
  parameters: Readonly<Record<string, unknown>>,
  name: string,
): string | undefined {
  const value = parameters[name];
  return typeof value === 'string' ? value : undefined;
}

function appendPointer(base: string, segment: string): string {
  const escaped = segment.replaceAll('~', '~0').replaceAll('/', '~1');
  return `${base}/${escaped}`;
}

function pointerOrRoot(pointer: string): string {
  return pointer === '' ? '/' : pointer;
}

function pointerToDotted(pointer: string): string {
  return pointer
    .split('/')
    .slice(1)
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .join('.');
}

// Conservative "what should I still ask the user?" helper. Full validation is
// provided by validateFormData; this remains exported for UI prompt flows that
// need an inexpensive required-field projection.
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
