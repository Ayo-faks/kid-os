import { ActivityContext } from '@microsoft/durabletask-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const incidentMocks = vi.hoisted(() => ({
  exportPdf: vi.fn(),
  persistIncidentVersion: vi.fn(),
  resolveIncidentApprovalRequirement: vi.fn(),
  routeForApproval: vi.fn(),
  validateAgainstSchema: vi.fn(),
  writeAuditEvent: vi.fn(),
}));
const followUpMocks = vi.hoisted(() => ({ ensureIncidentFollowUpActions: vi.fn() }));
const withTenantContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../activities/incidents.js', () => incidentMocks);
vi.mock('../../activities/incident-follow-ups.js', () => followUpMocks);
vi.mock('../../db/pg.js', () => ({ withTenantContext: withTenantContextMock }));

import {
  applyIncidentCommandActivity,
  initializeIncidentFromCommandActivity,
  recordIncidentApprovalResultActivity,
} from './incident-report.activities.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const residentId = '33333333-3333-4333-8333-333333333333';
const authorUserId = '44444444-4444-4444-8444-444444444444';
const incidentId = '55555555-5555-4555-8555-555555555555';
const managerId = '66666666-6666-4666-8666-666666666666';
const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const actor = { correlationId: 'corr-incident', kind: 'user' as const, userId: authorUserId };
const context = new ActivityContext('incident-test', 1);

const currentRow = {
  author_user_id: authorUserId,
  form_data: { residentId, summary: 'Persisted source text' },
  missing_mandatory: [],
  resident_id: residentId,
  status: 'draft',
  template_id: 'incident.behavioural',
  template_version: 'v1',
  version: 1,
};

describe('Durable incident activities', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('initializes from a persisted command and returns sanitized state', async () => {
    const query = tenantQuery([
      {
        rows: [
          {
            command_type: 'incident.initialize',
            payload: { initialFormData: { residentId, summary: 'Persisted source text' } },
          },
        ],
        rowCount: 1,
      },
      { rows: [], rowCount: 1 },
    ]);
    incidentMocks.validateAgainstSchema.mockResolvedValue({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
    incidentMocks.persistIncidentVersion.mockResolvedValue({ version: 1, versionId: 'v1' });

    const result = await initializeIncidentFromCommandActivity(context, {
      actor,
      authorUserId,
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      homeId,
      incidentId,
      initialCommandId: commandId,
      residentId,
      tenantId,
    });

    expect(incidentMocks.persistIncidentVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: { residentId, summary: 'Persisted source text' },
        status: 'draft',
        version: 1,
      }),
    );
    expect(query.mock.calls[1]?.[0]).toContain("status = 'applied'");
    expect(result).toEqual({
      currentVersion: 1,
      incidentId,
      missingMandatory: [],
      status: 'draft',
    });
    expect(JSON.stringify(result)).not.toContain('Persisted source text');
  });

  it('submits persisted form data and returns an ID-only approval request', async () => {
    tenantQuery([
      {
        rows: [
          {
            command_type: 'incident.submit',
            payload: { actor },
          },
        ],
        rowCount: 1,
      },
      { rows: [currentRow], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    incidentMocks.validateAgainstSchema.mockResolvedValue({
      errors: [],
      missingMandatory: [],
      valid: true,
    });
    incidentMocks.resolveIncidentApprovalRequirement.mockResolvedValue({
      immediateRisk: false,
      level: 'confirm',
      requiredRoles: ['manager'],
      safeguarding: false,
      signaturesRequired: 1,
    });
    incidentMocks.persistIncidentVersion.mockResolvedValue({ version: 2, versionId: 'v2' });

    const result = await applyIncidentCommandActivity(context, {
      commandId,
      currentVersion: 1,
      homeId,
      incidentId,
      status: 'draft',
      tenantId,
    });

    expect(result).toMatchObject({
      approval: {
        approvalId: incidentId,
        requestedByUserId: authorUserId,
        requiredRoles: ['manager'],
        signaturesRequired: 1,
        subjectId: incidentId,
        subjectType: 'incident',
      },
      kind: 'await_approval',
      state: { currentVersion: 2, status: 'awaiting_approval' },
    });
    expect(JSON.stringify(result)).not.toContain('Persisted source text');
    expect(incidentMocks.routeForApproval).toHaveBeenCalledOnce();
  });

  it('persists an invalid draft update as awaiting fields', async () => {
    tenantQuery([
      {
        rows: [
          {
            command_type: 'incident.update',
            payload: { actor, formData: { summary: 'Still incomplete' } },
          },
        ],
        rowCount: 1,
      },
      { rows: [currentRow], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    incidentMocks.validateAgainstSchema.mockResolvedValue({
      errors: [{ message: 'is required', path: '/residentId' }],
      missingMandatory: ['residentId'],
      valid: false,
    });
    incidentMocks.persistIncidentVersion.mockResolvedValue({ version: 2, versionId: 'v2' });

    const result = await applyIncidentCommandActivity(context, {
      commandId,
      currentVersion: 1,
      homeId,
      incidentId,
      status: 'draft',
      tenantId,
    });

    expect(incidentMocks.persistIncidentVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        formData: { summary: 'Still incomplete' },
        missingMandatory: ['residentId'],
        status: 'awaiting_fields',
        validationErrors: [{ message: 'is required', path: '/residentId' }],
        version: 2,
      }),
    );
    expect(result).toEqual({
      kind: 'state',
      state: {
        currentVersion: 2,
        incidentId,
        missingMandatory: ['residentId'],
        status: 'awaiting_fields',
      },
    });
  });

  it('rejects submission with missing fields without starting Approval', async () => {
    tenantQuery([
      {
        rows: [{ command_type: 'incident.submit', payload: { actor } }],
        rowCount: 1,
      },
      { rows: [currentRow], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    incidentMocks.validateAgainstSchema.mockResolvedValue({
      errors: [{ message: 'is required', path: '/residentId' }],
      missingMandatory: ['residentId'],
      valid: false,
    });
    incidentMocks.persistIncidentVersion.mockResolvedValue({ version: 2, versionId: 'v2' });

    const result = await applyIncidentCommandActivity(context, {
      commandId,
      currentVersion: 1,
      homeId,
      incidentId,
      status: 'draft',
      tenantId,
    });

    expect(result).toMatchObject({
      kind: 'state',
      state: { currentVersion: 2, missingMandatory: ['residentId'], status: 'awaiting_fields' },
    });
    expect(incidentMocks.routeForApproval).not.toHaveBeenCalled();
    expect(incidentMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'incident.submit_rejected_missing_fields',
        payload: { missingMandatory: ['residentId'] },
      }),
    );
  });

  it('exports an approved incident and completes its persisted runtime owner', async () => {
    const query = tenantQuery([
      {
        rows: [{ command_type: 'incident.export', payload: { actor } }],
        rowCount: 1,
      },
      { rows: [{ ...currentRow, status: 'approved', version: 3 }], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    incidentMocks.exportPdf.mockResolvedValue({
      objectKey: 'incidents/export.pdf',
      sha256: 'export-sha',
      sizeBytes: 1024,
    });

    const result = await applyIncidentCommandActivity(context, {
      commandId,
      currentVersion: 3,
      homeId,
      incidentId,
      status: 'approved',
      tenantId,
    });

    expect(incidentMocks.exportPdf).toHaveBeenCalledWith(
      expect.objectContaining({ formData: currentRow.form_data, version: 3 }),
    );
    expect(incidentMocks.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'incident.exported',
        payload: {
          objectKey: 'incidents/export.pdf',
          sha256: 'export-sha',
          sizeBytes: 1024,
        },
      }),
    );
    expect(query.mock.calls[3]?.[0]).toContain("SET status = 'completed'");
    expect(result).toEqual({
      kind: 'state',
      state: {
        currentVersion: 3,
        exportObjectKey: 'incidents/export.pdf',
        incidentId,
        missingMandatory: [],
        status: 'exported',
      },
    });
  });

  it('persists a terminal approval and creates deterministic follow-up rows', async () => {
    tenantQuery([
      { rows: [{ ...currentRow, status: 'awaiting_approval', version: 2 }], rowCount: 1 },
    ]);
    incidentMocks.resolveIncidentApprovalRequirement.mockResolvedValue({
      immediateRisk: true,
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      safeguarding: true,
      signaturesRequired: 2,
    });
    incidentMocks.persistIncidentVersion.mockResolvedValue({ version: 3, versionId: 'v3' });
    followUpMocks.ensureIncidentFollowUpActions.mockResolvedValue([
      {
        actionId: '77777777-7777-4777-8777-777777777777',
        attempt: 1,
        kind: 'safeguarding_email',
        targetId: '88888888-8888-4888-8888-888888888888',
        workflowId: 'incident-follow-up-77777777-7777-4777-8777-777777777777-attempt-1',
      },
    ]);

    const result = await recordIncidentApprovalResultActivity(context, {
      approval: {
        approvalId: incidentId,
        requiredRoles: ['manager', 'safeguarding_lead'],
        signatures: [{ decision: 'approved', role: 'manager', userId: managerId }],
        signaturesRequired: 2,
        status: 'approved',
        subjectId: incidentId,
        subjectType: 'incident',
      },
      correlationId: 'corr-approval-terminal',
      homeId,
      incidentId,
      tenantId,
    });

    expect(incidentMocks.persistIncidentVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: expect.objectContaining({ userId: managerId }),
        status: 'approved',
        version: 3,
      }),
    );
    expect(followUpMocks.ensureIncidentFollowUpActions).toHaveBeenCalledWith(
      expect.objectContaining({ immediateRisk: true, safeguarding: true }),
    );
    expect(followUpMocks.ensureIncidentFollowUpActions).toHaveBeenCalledWith(
      expect.objectContaining({
        orchestrationName: 'IncidentFollowUpActionOrchestratorV1',
        runtime: 'durable',
      }),
    );
    expect(result).toMatchObject({
      followUps: [expect.objectContaining({ kind: 'safeguarding_email' })],
      state: { currentVersion: 3, status: 'approved' },
    });
  });
});

function tenantQuery(
  results: Array<{ readonly rows: readonly unknown[]; readonly rowCount: number }>,
) {
  const query = vi.fn();
  for (const result of results) query.mockResolvedValueOnce(result);
  withTenantContextMock.mockImplementation(
    (_tenantContext: unknown, callback: (client: { query: typeof query }) => Promise<unknown>) =>
      callback({ query }),
  );
  return query;
}
