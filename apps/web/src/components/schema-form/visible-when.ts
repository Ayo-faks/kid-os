import type { UiSchema } from '@careos/schemas/runtime';

export function isFieldVisible(
  uiSchema: UiSchema,
  fieldName: string,
  values: Readonly<Record<string, unknown>>,
): boolean {
  const widget = uiSchema.widgets?.[fieldName];
  const rule = widget?.visibleWhen;
  if (!rule) return true;
  return values[rule.field] === rule.equals;
}
