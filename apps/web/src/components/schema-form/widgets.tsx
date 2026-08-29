'use client';

import type { JsonSchema, UiSchema, UiWidget } from '@careos/schemas/runtime';
import type { JSX, ReactNode } from 'react';
import {
  Controller,
  type Control,
  type FieldError,
  type UseFormRegisterReturn,
} from 'react-hook-form';

export interface WidgetCommonProps {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly ui: UiWidget | undefined;
  readonly error: FieldError | undefined;
  readonly control: Control<Record<string, unknown>>;
  readonly register: (name: string) => UseFormRegisterReturn;
}

export interface ResidentOption {
  readonly id: string;
  readonly displayName: string;
}

export interface ResidentPickerContext {
  readonly residents: readonly ResidentOption[];
}

export function resolveWidget(uiSchema: UiSchema, fieldName: string, schema: JsonSchema): string {
  const explicit = uiSchema.widgets?.[fieldName]?.widget;
  if (explicit) return explicit;
  if (schema.enum) return 'select';
  if (schema.type === 'boolean') return 'toggle';
  if (schema.type === 'array' && schema.items?.type === 'string') return 'tag-input';
  if (schema.type === 'array' && schema.items?.type === 'object') return 'repeating-group';
  if (schema.format === 'date-time') return 'datetime';
  return 'text';
}

function fieldLabel(schema: JsonSchema, name: string): string {
  return schema.title ?? humanize(name);
}

function humanize(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

function describedById(name: string): string {
  return `field-${name}`;
}

function errorId(name: string): string {
  return `field-${name}-error`;
}

const baseInput =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

const labelClass = 'mb-1 block text-sm font-medium text-foreground';
const helpClass = 'mt-1 text-xs text-muted-foreground';
const errorClass = 'mt-1 text-xs text-destructive';

function FieldShell({
  name,
  schema,
  error,
  children,
  required,
}: {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly error: FieldError | undefined;
  readonly children: ReactNode;
  readonly required: boolean;
}): JSX.Element {
  return (
    <div className="space-y-1" data-field={name}>
      <div className={labelClass}>
        <label htmlFor={describedById(name)}>{fieldLabel(schema, name)}</label>
        {required ? (
          <span aria-hidden className="ml-1 text-destructive">
            *
          </span>
        ) : null}
      </div>
      {children}
      {schema.description ? <p className={helpClass}>{schema.description}</p> : null}
      {error ? (
        <p id={errorId(name)} role="alert" className={errorClass}>
          {error.message ?? 'Invalid value'}
        </p>
      ) : null}
    </div>
  );
}

export function TextWidget(props: WidgetCommonProps & { readonly required: boolean }): JSX.Element {
  const { name, schema, ui, error, register, required } = props;
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <input
        id={describedById(name)}
        type="text"
        placeholder={ui?.placeholder}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId(name) : undefined}
        className={baseInput}
        {...register(name)}
      />
    </FieldShell>
  );
}

export function TextAreaWidget(
  props: WidgetCommonProps & { readonly required: boolean },
): JSX.Element {
  const { name, schema, ui, error, register, required } = props;
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <textarea
        id={describedById(name)}
        rows={ui?.rows ?? 4}
        placeholder={ui?.placeholder}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId(name) : undefined}
        className={baseInput}
        {...register(name)}
      />
    </FieldShell>
  );
}

export function DateTimeWidget(
  props: WidgetCommonProps & { readonly required: boolean },
): JSX.Element {
  const { name, schema, error, control, required } = props;
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <Controller
        name={name}
        control={control}
        render={({ field }) => {
          const isoValue = typeof field.value === 'string' ? field.value : '';
          const localValue = isoValue ? toDateTimeLocal(isoValue) : '';
          return (
            <input
              id={describedById(name)}
              type="datetime-local"
              value={localValue}
              onChange={(event) => {
                const raw = event.target.value;
                field.onChange(raw ? fromDateTimeLocal(raw) : '');
              }}
              onBlur={field.onBlur}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? errorId(name) : undefined}
              className={baseInput}
            />
          );
        }}
      />
    </FieldShell>
  );
}

function toDateTimeLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromDateTimeLocal(local: string): string {
  const d = new Date(local);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

export function SelectWidget(
  props: WidgetCommonProps & { readonly required: boolean },
): JSX.Element {
  const { name, schema, error, register, required } = props;
  const options = (schema.enum ?? []).filter((v): v is string => typeof v === 'string');
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <select
        id={describedById(name)}
        defaultValue=""
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId(name) : undefined}
        className={baseInput}
        {...register(name)}
      >
        <option value="" disabled>
          Select…
        </option>
        {options.map((value) => (
          <option key={value} value={value}>
            {humanize(value)}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function ToggleWidget(
  props: WidgetCommonProps & { readonly required: boolean },
): JSX.Element {
  const { name, schema, error, control, required } = props;
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <Controller
        name={name}
        control={control}
        render={({ field }) => (
          <label className="inline-flex items-center gap-2">
            <input
              id={describedById(name)}
              type="checkbox"
              checked={field.value === true}
              onChange={(event) => field.onChange(event.target.checked)}
              onBlur={field.onBlur}
              aria-invalid={error ? 'true' : undefined}
              aria-describedby={error ? errorId(name) : undefined}
              className="h-4 w-4 rounded border-input"
            />
            <span className="text-sm text-foreground">Yes</span>
          </label>
        )}
      />
    </FieldShell>
  );
}

export function TagInputWidget(
  props: WidgetCommonProps & { readonly required: boolean },
): JSX.Element {
  const { name, schema, ui, error, control, required } = props;
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <Controller
        name={name}
        control={control}
        defaultValue={[]}
        render={({ field }) => {
          const tags = Array.isArray(field.value) ? (field.value as string[]) : [];
          return (
            <div
              data-tag-input
              data-field={name}
              className="flex flex-wrap gap-2 rounded-md border border-input bg-background p-2"
            >
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
                >
                  {tag}
                  <button
                    type="button"
                    aria-label={`Remove ${tag}`}
                    className="ml-1 text-muted-foreground hover:text-foreground"
                    onClick={() => field.onChange(tags.filter((t) => t !== tag))}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                id={describedById(name)}
                type="text"
                placeholder={ui?.placeholder ?? 'Add and press Enter'}
                aria-invalid={error ? 'true' : undefined}
                aria-describedby={error ? errorId(name) : undefined}
                className="min-w-[8rem] flex-1 bg-transparent text-sm outline-none"
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ',') return;
                  event.preventDefault();
                  const target = event.currentTarget;
                  const raw = target.value.trim();
                  if (!raw || tags.includes(raw)) {
                    target.value = '';
                    return;
                  }
                  field.onChange([...tags, raw]);
                  target.value = '';
                }}
                onBlur={field.onBlur}
              />
            </div>
          );
        }}
      />
    </FieldShell>
  );
}

export function RepeatingGroupWidget(
  props: WidgetCommonProps & { readonly required: boolean },
): JSX.Element {
  const { name, schema, error, control, required } = props;
  const itemSchema = schema.items;
  const itemProps = itemSchema?.properties ?? {};
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <Controller
        name={name}
        control={control}
        defaultValue={[]}
        render={({ field }) => {
          const items = Array.isArray(field.value)
            ? (field.value as Record<string, unknown>[])
            : [];
          return (
            <div data-repeating-group={name} className="space-y-3">
              {items.map((item, index) => (
                <div
                  key={index}
                  data-repeating-item={index}
                  className="space-y-2 rounded-md border border-input bg-background p-3"
                >
                  {Object.entries(itemProps).map(([childKey, childSchema]) => (
                    <RepeatingFieldRow
                      key={childKey}
                      name={childKey}
                      schema={childSchema}
                      value={item[childKey]}
                      onChange={(next) => {
                        const updated = items.map((entry, i) =>
                          i === index ? { ...entry, [childKey]: next } : entry,
                        );
                        field.onChange(updated);
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    className="text-xs text-destructive hover:underline"
                    onClick={() => field.onChange(items.filter((_, i) => i !== index))}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="rounded-md border border-dashed border-input px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => field.onChange([...items, {}])}
              >
                + Add
              </button>
            </div>
          );
        }}
      />
    </FieldShell>
  );
}

function RepeatingFieldRow({
  name,
  schema,
  value,
  onChange,
}: {
  readonly name: string;
  readonly schema: JsonSchema;
  readonly value: unknown;
  readonly onChange: (next: unknown) => void;
}): JSX.Element {
  const id = `repeat-${name}-${Math.random().toString(36).slice(2, 7)}`;

  if (schema.enum) {
    const options = schema.enum.filter((v): v is string => typeof v === 'string');
    return (
      <div className="space-y-1">
        <label htmlFor={id} className={labelClass}>
          {fieldLabel(schema, name)}
        </label>
        <select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className={baseInput}
        >
          <option value="" disabled>
            Select…
          </option>
          {options.map((opt) => (
            <option key={opt} value={opt}>
              {humanize(opt)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (schema.type === 'boolean') {
    return (
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="h-4 w-4 rounded border-input"
        />
        <span className="text-sm text-foreground">{fieldLabel(schema, name)}</span>
      </label>
    );
  }

  return (
    <div className="space-y-1">
      <label htmlFor={id} className={labelClass}>
        {fieldLabel(schema, name)}
      </label>
      <input
        id={id}
        type="text"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
        className={baseInput}
      />
    </div>
  );
}

export function ResidentPickerWidget(
  props: WidgetCommonProps & {
    readonly required: boolean;
    readonly residents: readonly ResidentOption[];
  },
): JSX.Element {
  const { name, schema, error, register, required, residents } = props;
  return (
    <FieldShell name={name} schema={schema} error={error} required={required}>
      <select
        id={describedById(name)}
        defaultValue=""
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={error ? errorId(name) : undefined}
        className={baseInput}
        {...register(name)}
      >
        <option value="" disabled>
          Choose a resident…
        </option>
        {residents.map((resident) => (
          <option key={resident.id} value={resident.id}>
            {resident.displayName}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
