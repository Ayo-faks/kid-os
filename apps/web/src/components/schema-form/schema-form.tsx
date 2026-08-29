'use client';

import { getMissingMandatoryFields, type JsonSchema, type UiSchema } from '@careos/schemas/runtime';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, type JSX } from 'react';
import { useForm, type FieldError } from 'react-hook-form';

import { jsonSchemaToZod } from './schema-to-zod';
import { isFieldVisible } from './visible-when';
import {
  DateTimeWidget,
  RepeatingGroupWidget,
  ResidentPickerWidget,
  SelectWidget,
  TagInputWidget,
  TextAreaWidget,
  TextWidget,
  ToggleWidget,
  resolveWidget,
  type ResidentOption,
} from './widgets';

export interface SchemaFormSubmitResult {
  readonly formData: Record<string, unknown>;
  readonly missingMandatory: readonly string[];
}

export interface SchemaFormProps {
  readonly schema: JsonSchema;
  readonly uiSchema: UiSchema;
  readonly defaultValues?: Readonly<Record<string, unknown>>;
  readonly residents?: readonly ResidentOption[];
  readonly onSubmit: (result: SchemaFormSubmitResult) => void | Promise<void>;
  readonly onSaveDraft?: (result: SchemaFormSubmitResult) => void | Promise<void>;
  readonly submitLabel?: string;
  readonly disabled?: boolean;
}

export function SchemaForm({
  schema,
  uiSchema,
  defaultValues,
  residents = [],
  onSubmit,
  onSaveDraft,
  submitLabel = 'Submit',
  disabled = false,
}: SchemaFormProps): JSX.Element {
  // Build two zod schemas: one strict (submit) and one lax (draft). Draft mode
  // skips required-field enforcement so users can save partial work; mandatory
  // gaps are surfaced separately via getMissingMandatoryFields().
  const submitZod = useMemo(() => jsonSchemaToZod(schema, { enforceRequired: true }), [schema]);

  const form = useForm<Record<string, unknown>>({
    defaultValues: { ...(defaultValues ?? {}) },
    resolver: zodResolver(submitZod),
    mode: 'onBlur',
  });

  const values = form.watch();

  const handleSubmit = form.handleSubmit(async (formData) => {
    const missingMandatory = getMissingMandatoryFields(schema, formData);
    await onSubmit({ formData, missingMandatory });
  });

  const handleSaveDraft = async (): Promise<void> => {
    if (!onSaveDraft) return;
    const formData = form.getValues();
    const missingMandatory = getMissingMandatoryFields(schema, formData);
    await onSaveDraft({ formData, missingMandatory });
  };

  const sections = uiSchema.sections ?? inferSections(schema, uiSchema);
  const requiredSet = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};
  const errors = form.formState.errors;

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="space-y-8" noValidate>
      {sections.map((section) => (
        <fieldset
          key={section.title}
          data-section={section.title}
          className="space-y-4 rounded-lg border border-border bg-card p-4"
        >
          <legend className="px-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            {section.title}
          </legend>
          <div className="space-y-4">
            {section.fields.map((fieldName) => {
              const fieldSchema = properties[fieldName];
              if (!fieldSchema) return null;
              if (!isFieldVisible(uiSchema, fieldName, values)) return null;

              const widget = resolveWidget(uiSchema, fieldName, fieldSchema);
              const isRequired = requiredSet.has(fieldName) || fieldSchema['x-mandatory'] === true;
              const ui = uiSchema.widgets?.[fieldName];
              const error = errors[fieldName] as FieldError | undefined;

              const common = {
                name: fieldName,
                schema: fieldSchema,
                ui,
                error,
                control: form.control,
                register: form.register,
                required: isRequired,
              };

              switch (widget) {
                case 'textarea':
                  return <TextAreaWidget key={fieldName} {...common} />;
                case 'datetime':
                  return <DateTimeWidget key={fieldName} {...common} />;
                case 'select':
                  return <SelectWidget key={fieldName} {...common} />;
                case 'toggle':
                  return <ToggleWidget key={fieldName} {...common} />;
                case 'tag-input':
                  return <TagInputWidget key={fieldName} {...common} />;
                case 'repeating-group':
                  return <RepeatingGroupWidget key={fieldName} {...common} />;
                case 'resident-picker':
                  return <ResidentPickerWidget key={fieldName} {...common} residents={residents} />;
                case 'text':
                default:
                  return <TextWidget key={fieldName} {...common} />;
              }
            })}
          </div>
        </fieldset>
      ))}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={disabled || form.formState.isSubmitting}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitLabel}
        </button>
        {onSaveDraft ? (
          <button
            type="button"
            onClick={() => void handleSaveDraft()}
            disabled={disabled || form.formState.isSubmitting}
            className="rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            Save draft
          </button>
        ) : null}
      </div>
    </form>
  );
}

function inferSections(
  schema: JsonSchema,
  uiSchema: UiSchema,
): readonly { readonly title: string; readonly fields: readonly string[] }[] {
  const order = uiSchema.order ?? Object.keys(schema.properties ?? {});
  return [{ title: schema.title ?? 'Form', fields: order }];
}
