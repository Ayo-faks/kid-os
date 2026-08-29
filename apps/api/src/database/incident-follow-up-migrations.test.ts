import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../prisma/migrations');
const contactMigration = readFileSync(
  resolve(root, '0018_home_safeguarding_contact/migration.sql'),
  'utf8',
);
const followUpMigration = readFileSync(
  resolve(root, '0019_incident_follow_up_actions/migration.sql'),
  'utf8',
);

describe('incident follow-up migrations', () => {
  it('requires safeguarding contact fields to be configured or cleared as a pair', () => {
    expect(contactMigration).toContain('homes_safeguarding_contact_pair_check');
    expect(contactMigration).toContain('safeguarding_contact_name');
    expect(contactMigration).toContain('safeguarding_contact_email');
  });

  it('records only contact configured state in append-only audit data', () => {
    const auditFunction = contactMigration.slice(
      contactMigration.indexOf('on_home_safeguarding_contact_change'),
    );
    expect(auditFunction).toContain("'configured'");
    expect(auditFunction).not.toContain("'safeguarding_contact_email'");
    expect(auditFunction).not.toContain("'safeguarding_contact_name'");
  });

  it('enforces semantic idempotency, durable target identity, and tenant-home RLS', () => {
    expect(followUpMigration).toContain('"target_id" UUID NOT NULL');
    expect(followUpMigration).toContain('incident_follow_up_actions_semantic_key');
    expect(followUpMigration).toContain('"tenant_id", "home_id", "incident_id", "kind"');
    expect(followUpMigration).toContain('ENABLE ROW LEVEL SECURITY');
    expect(followUpMigration).toContain("current_setting('app.current_tenant_id'");
    expect(followUpMigration).toContain("current_setting('app.current_home_id'");
  });

  it('keeps contact details and generated email content out of follow-up audit diffs', () => {
    expect(followUpMigration).not.toContain('recipient_email');
    expect(followUpMigration).not.toContain('email_body');
    expect(followUpMigration).not.toContain('safeguarding_contact_email');
  });
});
