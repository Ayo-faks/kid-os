import { loadFormTemplate } from '@careos/schemas';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { SchemaForm } from './schema-form';

describe('SchemaForm snapshot', () => {
  it('renders incident.behavioural.v1 with all sections and required markers', () => {
    const template = loadFormTemplate('incident.behavioural', 'v1');
    const html = renderToStaticMarkup(
      <SchemaForm
        schema={template.schema}
        uiSchema={template.uiSchema}
        residents={[
          { id: '11111111-1111-4111-8111-111111111111', displayName: 'Alex P.' },
          { id: '22222222-2222-4222-8222-222222222222', displayName: 'Brooke L.' },
        ]}
        onSubmit={() => undefined}
        onSaveDraft={() => undefined}
        submitLabel="Submit incident"
      />,
    );

    // Section legends.
    expect(html).toContain('Basics');
    expect(html).toContain('What happened');
    expect(html).toContain('Intervention');
    expect(html).toContain('Outcome');

    // Field labels driven by schema.title.
    expect(html).toContain('Resident');
    expect(html).toContain('When did it happen?');
    expect(html).toContain('Where did it happen?');
    expect(html).toContain('What happened?');

    // Required marker on mandatory fields (single asterisk, aria-hidden).
    const asterisks = html.match(/aria-hidden="true" class="ml-1 text-destructive">\*</g) ?? [];
    expect(asterisks.length).toBeGreaterThanOrEqual(8); // 8 x-mandatory fields

    // Widgets pulled from ui schema.
    expect(html).toContain('placeholder="e.g. Lounge, Bedroom 3, school transport"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toContain('data-tag-input');
    expect(html).toContain('data-repeating-group="injuries"');

    // Conditional field is hidden by default (visibleWhen: physicalInterventionUsed=true).
    expect(html).not.toContain('data-field="physicalInterventionDetail"');

    // Resident-picker shows resident options.
    expect(html).toContain('Alex P.');
    expect(html).toContain('Brooke L.');

    // Behaviour-type select renders enum options humanized.
    expect(html).toContain('Verbal aggression');
    expect(html).toContain('Self harm');

    // Submit + Save draft buttons.
    expect(html).toContain('Submit incident');
    expect(html).toContain('Save draft');
  });
});
