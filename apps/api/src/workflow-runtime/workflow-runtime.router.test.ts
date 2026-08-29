import type { ApprovalDecisionSignal } from '@careos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkflowRuntimeRouter } from './workflow-runtime.router.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const managerId = '55555555-5555-4555-8555-555555555555';
const commandId = '88888888-8888-4888-8888-888888888888';
const instanceId = `approval-${approvalId}`;

const payload: ApprovalDecisionSignal = {
  actor: { correlationId: 'corr-approval', kind: 'user', userId: managerId },
  decidedByUserId: managerId,
  decision: 'approved',
  reason: 'Reviewed against the source record.',
};

describe('WorkflowRuntimeRouter approval decisions', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it.each([{ ownerRows: [] }, { ownerRows: [{ id: 'owner-1', instanceId, runtime: 'temporal' }] }])(
    'keeps legacy and Temporal-owned approvals on Temporal',
    async ({ ownerRows }) => {
      const harness = createHarness([ownerRows]);

      await harness.router.signalApprovalDecision(approvalId, payload, { homeId, tenantId });

      expect(harness.temporal.signalApprovalDecision).toHaveBeenCalledWith(approvalId, payload);
      expect(harness.durable.raiseDecision).not.toHaveBeenCalled();
    },
  );

  it('persists prose under RLS and raises only the opaque command id for Durable ownership', async () => {
    const harness = createHarness([
      [{ id: '99999999-9999-4999-8999-999999999999', instanceId, runtime: 'durable' }],
      [{ id: commandId }],
    ]);

    await harness.router.signalApprovalDecision(approvalId, payload, { homeId, tenantId });

    expect(harness.temporal.signalApprovalDecision).not.toHaveBeenCalled();
    expect(harness.durable.raiseDecision).toHaveBeenCalledWith(instanceId, commandId);
    const insert = harness.queryRaw.mock.calls[1];
    expect(JSON.stringify(insert)).toContain('Reviewed against the source record.');
    expect(harness.durable.raiseDecision.mock.calls[0]).not.toContain(payload.reason);
    expect(harness.prisma.withTenantContext).toHaveBeenCalledWith(
      { actor: payload.actor, homeId, tenantId },
      expect.any(Function),
    );
  });

  it('reuses a deduplicated command returned by the database', async () => {
    const harness = createHarness([
      [{ id: '99999999-9999-4999-8999-999999999999', instanceId, runtime: 'durable' }],
      [{ id: commandId }],
    ]);

    await harness.router.signalApprovalDecision(approvalId, payload, { homeId, tenantId });

    expect(harness.durable.raiseDecision).toHaveBeenCalledWith(instanceId, commandId);
    expect(String(harness.queryRaw.mock.calls[1]?.[0])).toContain('ON CONFLICT');
  });

  it('keeps Ping starts on Temporal by default', async () => {
    const harness = createHarness([]);

    await expect(harness.router.startPingWorkflow('Temporal ping text.')).resolves.toMatchObject({
      taskQueue: 'careos.phase0',
      workflowId: 'phase0-ping-temporal',
    });
    expect(harness.temporal.startPingWorkflow).toHaveBeenCalledWith('Temporal ping text.');
    expect(harness.ping.start).not.toHaveBeenCalled();
  });

  it('persists a custom Ping message and starts Durable with opaque IDs only', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_PING', 'durable');
    const harness = createHarness([]);
    harness.queryRaw.mockImplementationOnce((...args: unknown[]) => {
      const instanceIdValue = args.find(
        (value) => typeof value === 'string' && value.startsWith('phase0-ping-'),
      );
      return [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: instanceIdValue,
          runtime: 'durable',
        },
      ];
    });
    harness.queryRaw.mockResolvedValueOnce([{ id: commandId }]);

    await expect(
      harness.router.startPingWorkflow('Private custom Ping message.'),
    ).resolves.toMatchObject({
      taskQueue: 'careos.durable',
      workflowId: expect.stringMatching(/^phase0-ping-/),
    });

    expect(harness.prisma.withSystemContext).toHaveBeenCalledWith(
      { correlationId: expect.stringMatching(/^ping:/) },
      expect.any(Function),
    );
    expect(harness.ping.start).toHaveBeenCalledWith(
      expect.stringMatching(/^phase0-ping-/),
      expect.objectContaining({ commandId, correlationId: expect.stringMatching(/^ping:/) }),
    );
    expect(JSON.stringify(harness.ping.start.mock.calls[0])).not.toContain(
      'Private custom Ping message.',
    );
    expect(JSON.stringify(harness.queryRaw.mock.calls[1])).toContain(
      'Private custom Ping message.',
    );
  });

  it('rejects oversized Durable Ping messages before persistence', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_PING', 'durable');
    const harness = createHarness([]);

    await expect(harness.router.startPingWorkflow('x'.repeat(2_001))).rejects.toThrow(
      /between 1 and 2000/,
    );
    expect(harness.prisma.withSystemContext).not.toHaveBeenCalled();
    expect(harness.ping.start).not.toHaveBeenCalled();
  });

  it('persists initial form data before starting an ID-only Durable incident', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_INCIDENTS', 'durable');
    vi.stubEnv('WORKFLOW_RUNTIME_APPROVALS', 'durable');
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: 'incident-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          runtime: 'durable',
        },
      ],
      [{ id: commandId }],
    ]);

    const started = await harness.router.startIncidentReportWorkflow({
      authorUserId: managerId,
      correlationId: 'corr-incident',
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      homeId,
      incidentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      initialFormData: { narrative: 'resident details remain in Postgres' },
      residentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      tenantId,
    });

    expect(started).toMatchObject({
      incidentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskQueue: 'careos.durable',
      workflowId: 'incident-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(harness.incidents.start).toHaveBeenCalledWith(
      'incident-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      expect.objectContaining({
        initialCommandId: commandId,
        incidentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      }),
    );
    expect(JSON.stringify(harness.incidents.start.mock.calls[0])).not.toContain(
      'resident details remain in Postgres',
    );
    expect(JSON.stringify(harness.queryRaw.mock.calls[1])).toContain(
      'resident details remain in Postgres',
    );
  });

  it('registers Temporal incident ownership before starting the workflow', async () => {
    const incidentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const instanceId = `incident-${incidentId}`;
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId,
          runtime: 'temporal',
        },
      ],
    ]);

    await expect(
      harness.router.startIncidentReportWorkflow({
        authorUserId: managerId,
        correlationId: 'corr-temporal-incident',
        formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
        homeId,
        incidentId,
        residentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        tenantId,
      }),
    ).resolves.toMatchObject({ incidentId, workflowId: instanceId });

    expect(harness.queryRaw).toHaveBeenCalledTimes(1);
    expect(String(harness.queryRaw.mock.calls[0]?.[0])).toContain("'temporal'");
    expect(harness.temporal.startIncidentReportWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ incidentId }),
    );
  });

  it('rejects Durable incident starts without Durable Approval routing', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_INCIDENTS', 'durable');
    vi.stubEnv('WORKFLOW_RUNTIME_APPROVALS', 'temporal');
    const harness = createHarness([]);

    await expect(
      harness.router.startIncidentReportWorkflow({
        authorUserId: managerId,
        correlationId: 'corr-incident',
        formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
        homeId,
        incidentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        residentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        tenantId,
      }),
    ).rejects.toThrow(/WORKFLOW_RUNTIME_APPROVALS/);
  });

  it('routes Durable incident updates as opaque command events', async () => {
    const incidentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const incidentInstanceId = `incident-${incidentId}`;
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: incidentInstanceId,
          runtime: 'durable',
        },
      ],
      [{ id: commandId }],
    ]);

    await harness.router.signalUpdateDraft(
      incidentId,
      {
        actor: { correlationId: 'corr-rota-publish', kind: 'user', userId: managerId },
        formData: { narrative: 'stored command text' },
      },
      { homeId, tenantId },
    );

    expect(harness.incidents.raiseCommand).toHaveBeenCalledWith(incidentInstanceId, commandId);
    expect(JSON.stringify(harness.incidents.raiseCommand.mock.calls[0])).not.toContain(
      'stored command text',
    );
    expect(JSON.stringify(harness.queryRaw.mock.calls[1])).toContain('stored command text');
  });

  it('registers and starts Durable document ingestion with IDs only', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_DOCUMENTS', 'durable');
    const documentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const documentInstanceId = `doc-ingest-${documentId}`;
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: documentInstanceId,
          runtime: 'durable',
        },
      ],
    ]);
    const input = {
      actor: { correlationId: 'corr-rota-publish', kind: 'user' as const, userId: managerId },
      documentId,
      homeId,
      tenantId,
    };

    await expect(harness.router.startDocIngestWorkflow(input)).resolves.toEqual({
      documentId,
      runId: documentInstanceId,
      taskQueue: 'careos.durable',
      workflowId: documentInstanceId,
    });
    expect(harness.documents.start).toHaveBeenCalledWith(documentInstanceId, input);
    expect(String(harness.queryRaw.mock.calls[0]?.[0])).toContain("'document', 'document'");
  });

  it('keeps document ingestion on Temporal by default', async () => {
    const documentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const harness = createHarness([]);
    const input = {
      actor: payload.actor,
      documentId,
      homeId,
      tenantId,
    };

    await expect(harness.router.startDocIngestWorkflow(input)).resolves.toMatchObject({
      documentId,
      taskQueue: 'careos.documents',
      workflowId: `doc-ingest-${documentId}`,
    });
    expect(harness.temporal.startDocIngestWorkflow).toHaveBeenCalledWith(input);
    expect(harness.documents.start).not.toHaveBeenCalled();
  });

  it('registers and starts Durable serious incident export with IDs only', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_EXPORT_BUNDLES', 'durable');
    const bundleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const exportInstanceId = `serious-incident-export-${bundleId}`;
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: exportInstanceId,
          runtime: 'durable',
        },
      ],
    ]);
    const input = {
      actor: payload.actor,
      bundleId,
      homeId,
      incidentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      tenantId,
    };

    await expect(harness.router.startSeriousIncidentExportWorkflow(input)).resolves.toEqual({
      bundleId,
      runId: exportInstanceId,
      taskQueue: 'careos.durable',
      workflowId: exportInstanceId,
    });
    expect(harness.exportBundles.start).toHaveBeenCalledWith(exportInstanceId, input);
    expect(String(harness.queryRaw.mock.calls[0]?.[0])).toContain(
      "'export-bundle', 'export_bundle'",
    );
  });

  it('keeps serious incident export on Temporal by default', async () => {
    const bundleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const harness = createHarness([]);
    const input = {
      actor: payload.actor,
      bundleId,
      homeId,
      incidentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      tenantId,
    };

    await expect(harness.router.startSeriousIncidentExportWorkflow(input)).resolves.toMatchObject({
      bundleId,
      taskQueue: 'careos.export-bundles',
      workflowId: `serious-incident-export-${bundleId}`,
    });
    expect(harness.temporal.startSeriousIncidentExportWorkflow).toHaveBeenCalledWith(input);
    expect(harness.exportBundles.start).not.toHaveBeenCalled();
  });

  it('persists Handover prose and starts Durable with only its command ID', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_HANDOVERS', 'durable');
    const handoverId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const handoverInstanceId = `handover-${handoverId}`;
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: handoverInstanceId,
          runtime: 'durable',
        },
      ],
      [{ id: commandId }],
    ]);

    await expect(
      harness.router.startHandoverWorkflow({
        authorUserId: managerId,
        correlationId: 'corr-handover',
        freeText: 'Private handover narrative remains in Postgres.',
        handoverId,
        homeId,
        shiftId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
        tenantId,
        transcriptObjectKey: 'tenants/t/handovers/transcript.wav',
      }),
    ).resolves.toMatchObject({
      handoverId,
      taskQueue: 'careos.durable',
      workflowId: handoverInstanceId,
    });

    expect(harness.handovers.start).toHaveBeenCalledWith(
      handoverInstanceId,
      expect.objectContaining({ commandId, handoverId }),
    );
    expect(JSON.stringify(harness.handovers.start.mock.calls[0])).not.toContain(
      'Private handover narrative',
    );
    expect(JSON.stringify(harness.handovers.start.mock.calls[0])).not.toContain('transcript.wav');
    expect(JSON.stringify(harness.queryRaw.mock.calls[1])).toContain(
      'Private handover narrative remains in Postgres.',
    );
  });

  it('keeps Handover starts on Temporal by default', async () => {
    const handoverId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const harness = createHarness([]);
    const input = {
      authorUserId: managerId,
      correlationId: 'corr-handover',
      freeText: 'Temporal handover narrative.',
      handoverId,
      homeId,
      shiftId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
      tenantId,
    };

    await expect(harness.router.startHandoverWorkflow(input)).resolves.toMatchObject({
      handoverId,
      taskQueue: 'careos.handovers',
      workflowId: `handover-${handoverId}`,
    });
    expect(harness.temporal.startHandoverWorkflow).toHaveBeenCalledWith(input);
    expect(harness.handovers.start).not.toHaveBeenCalled();
  });

  it('persists Email Draft content and starts Durable with only its command ID', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_EMAIL_DRAFTS', 'durable');
    vi.stubEnv('WORKFLOW_RUNTIME_APPROVALS', 'durable');
    const emailDraftId = 'abababab-abab-4bab-8bab-abababababab';
    const emailInstanceId = `email-draft-${emailDraftId}`;
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: emailInstanceId,
          runtime: 'durable',
        },
      ],
      [{ id: commandId }],
    ]);

    await expect(
      harness.router.startEmailDraftWorkflow({
        authorUserId: managerId,
        correlationId: 'corr-email',
        emailDraftId,
        homeId,
        instructions: 'Draft a private email for review.',
        recipient: { email: 'guardian@example.test', name: 'Private Guardian' },
        source: { kind: 'general', summary: 'Private resident source summary.' },
        tenantId,
      }),
    ).resolves.toMatchObject({
      emailDraftId,
      taskQueue: 'careos.durable',
      workflowId: emailInstanceId,
    });

    expect(harness.emailDrafts.start).toHaveBeenCalledWith(
      emailInstanceId,
      expect.objectContaining({ commandId, emailDraftId }),
    );
    expect(JSON.stringify(harness.emailDrafts.start.mock.calls[0])).not.toContain(
      'guardian@example.test',
    );
    expect(JSON.stringify(harness.emailDrafts.start.mock.calls[0])).not.toContain(
      'Private resident source summary.',
    );
    expect(JSON.stringify(harness.queryRaw.mock.calls[1])).toContain('guardian@example.test');
  });

  it('rejects Durable Email Draft starts without Durable Approval routing', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_EMAIL_DRAFTS', 'durable');
    vi.stubEnv('WORKFLOW_RUNTIME_APPROVALS', 'temporal');
    const harness = createHarness([]);

    await expect(
      harness.router.startEmailDraftWorkflow({
        authorUserId: managerId,
        correlationId: 'corr-email',
        emailDraftId: 'abababab-abab-4bab-8bab-abababababab',
        homeId,
        instructions: 'Draft a private email for review.',
        recipient: { email: 'guardian@example.test' },
        source: { kind: 'general', summary: 'Private resident source summary.' },
        tenantId,
      }),
    ).rejects.toThrow(/WORKFLOW_RUNTIME_APPROVALS/);
  });

  it('keeps Email Draft starts on Temporal by default', async () => {
    const emailDraftId = 'abababab-abab-4bab-8bab-abababababab';
    const harness = createHarness([]);
    const input = {
      authorUserId: managerId,
      correlationId: 'corr-email',
      emailDraftId,
      homeId,
      instructions: 'Draft a private email for review.',
      recipient: { email: 'guardian@example.test' },
      source: { kind: 'general' as const, summary: 'Private resident source summary.' },
      tenantId,
    };

    await expect(harness.router.startEmailDraftWorkflow(input)).resolves.toMatchObject({
      emailDraftId,
      taskQueue: 'careos.emails',
      workflowId: `email-draft-${emailDraftId}`,
    });
    expect(harness.temporal.startEmailDraftWorkflow).toHaveBeenCalledWith(input);
    expect(harness.emailDrafts.start).not.toHaveBeenCalled();
  });

  it('persists a Rota Publish note and starts Durable with IDs only', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_ROTA_PUBLISH', 'durable');
    const publicationId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const rotaInstanceId = `rota-publish-${publicationId}`;
    const harness = createHarness([
      [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: rotaInstanceId,
          runtime: 'durable',
        },
      ],
      [{ id: commandId }],
    ]);

    await expect(
      harness.router.startRotaPublishWorkflow({
        actor: { correlationId: 'corr-rota-publish', kind: 'user', userId: managerId },
        correlationId: 'corr-rota-publish',
        homeId,
        note: 'Private manager publication note.',
        periodEnd: '2026-07-25T00:00:00.000Z',
        periodStart: '2026-07-18T00:00:00.000Z',
        publicationId,
        publishedByUserId: managerId,
        shiftIds: ['dededede-dede-4ede-8ede-dededededede'],
        tenantId,
      }),
    ).resolves.toMatchObject({
      publicationId,
      taskQueue: 'careos.durable',
      workflowId: rotaInstanceId,
    });
    expect(harness.rotaPublish.start).toHaveBeenCalledWith(
      rotaInstanceId,
      expect.objectContaining({ commandId, publicationId }),
    );
    expect(JSON.stringify(harness.rotaPublish.start.mock.calls[0])).not.toContain(
      'Private manager publication note.',
    );
    expect(JSON.stringify(harness.queryRaw.mock.calls[1])).toContain(
      'Private manager publication note.',
    );
  });

  it('keeps Rota Publish starts on Temporal by default', async () => {
    const publicationId = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const harness = createHarness([]);
    const input = {
      actor: { correlationId: 'corr-rota-publish', kind: 'user' as const, userId: managerId },
      correlationId: 'corr-rota-publish',
      homeId,
      note: 'Temporal publication note.',
      periodEnd: '2026-07-25T00:00:00.000Z',
      periodStart: '2026-07-18T00:00:00.000Z',
      publicationId,
      publishedByUserId: managerId,
      shiftIds: ['dededede-dede-4ede-8ede-dededededede'],
      tenantId,
    };

    await expect(harness.router.startRotaPublishWorkflow(input)).resolves.toMatchObject({
      publicationId,
      taskQueue: 'careos.rota',
      workflowId: `rota-publish-${publicationId}`,
    });
    expect(harness.temporal.startRotaPublishWorkflow).toHaveBeenCalledWith(input);
    expect(harness.rotaPublish.start).not.toHaveBeenCalled();
  });

  it('keeps synchronous Rota Analyze on Temporal by default', async () => {
    const harness = createHarness([]);
    const input = rotaAnalyzeInput();

    await expect(harness.router.executeRotaAnalyzeWorkflow(input)).resolves.toEqual(
      rotaAnalyzeResult(),
    );

    expect(harness.temporal.executeRotaAnalyzeWorkflow).toHaveBeenCalledWith(input);
    expect(harness.rotaAnalyze.execute).not.toHaveBeenCalled();
  });

  it('keeps manual Retention sweeps on Temporal by default', async () => {
    const harness = createHarness([]);
    const input = retentionSweepInput();

    await expect(harness.router.startRetentionSweepWorkflow(input)).resolves.toMatchObject({
      taskQueue: 'careos.retention',
    });

    expect(harness.temporal.startRetentionSweepWorkflow).toHaveBeenCalledWith(input);
    expect(harness.retention.start).not.toHaveBeenCalled();
  });

  it('registers a manual Durable Retention owner before starting an aggregate-only sweep', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_RETENTION', 'durable');
    const harness = createHarness([]);
    harness.queryRaw.mockImplementationOnce((...args: unknown[]) => {
      const instanceIdValue = args.find(
        (value) => typeof value === 'string' && value.startsWith('retention-sweep-'),
      );
      return [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: instanceIdValue,
          runtime: 'durable',
        },
      ];
    });

    await expect(
      harness.router.startRetentionSweepWorkflow(retentionSweepInput()),
    ).resolves.toMatchObject({
      taskQueue: 'careos.durable',
      workflowId: expect.stringMatching(/^retention-sweep-/),
    });

    expect(harness.retention.start).toHaveBeenCalledWith(
      expect.stringMatching(/^retention-sweep-/),
      expect.objectContaining({
        correlationId: 'corr-retention',
        nowIso: '2026-07-18T01:00:00.000Z',
        owner: {
          homeId,
          tenantId,
          workflowInstanceId: '99999999-9999-4999-8999-999999999999',
        },
      }),
    );
    expect(JSON.stringify(harness.retention.start.mock.calls[0])).not.toContain('actor');
    expect(String(harness.queryRaw.mock.calls[0]?.[0])).toContain('core.workflow_instances');
  });

  it('persists and executes ID-only Durable Rota Analyze, then reads the RLS result', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_ROTA_ANALYZE', 'durable');
    const result = rotaAnalyzeResult();
    const harness = createHarness([]);
    harness.queryRaw.mockImplementationOnce((...args: unknown[]) => {
      const instanceIdValue = args.find(
        (value) => typeof value === 'string' && value.startsWith('rota-analyze-'),
      );
      return [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: instanceIdValue,
          runtime: 'durable',
        },
      ];
    });
    harness.queryRaw.mockResolvedValueOnce([]);
    harness.queryRaw.mockResolvedValueOnce([{ id: commandId }]);
    harness.queryRaw.mockResolvedValueOnce([{ failureCode: null, result, status: 'completed' }]);

    await expect(harness.router.executeRotaAnalyzeWorkflow(rotaAnalyzeInput())).resolves.toEqual(
      result,
    );

    expect(harness.rotaAnalyze.execute).toHaveBeenCalledWith(
      expect.stringMatching(/^rota-analyze-/),
      expect.objectContaining({ commandId, homeId, requestedByUserId: managerId, tenantId }),
    );
    expect(JSON.stringify(harness.rotaAnalyze.execute.mock.calls[0])).not.toContain('2026-07-18');
    expect(JSON.stringify(harness.queryRaw.mock.calls[2])).toContain('2026-07-18');
    expect(String(harness.queryRaw.mock.calls[3]?.[0])).toContain('core.rota_analysis_results');
  });

  it('rejects a malformed persisted Durable Rota Analyze result', async () => {
    vi.stubEnv('WORKFLOW_RUNTIME_ROTA_ANALYZE', 'durable');
    const harness = createHarness([]);
    harness.queryRaw.mockImplementationOnce((...args: unknown[]) => {
      const instanceIdValue = args.find(
        (value) => typeof value === 'string' && value.startsWith('rota-analyze-'),
      );
      return [
        {
          id: '99999999-9999-4999-8999-999999999999',
          instanceId: instanceIdValue,
          runtime: 'durable',
        },
      ];
    });
    harness.queryRaw.mockResolvedValueOnce([]);
    harness.queryRaw.mockResolvedValueOnce([{ id: commandId }]);
    harness.queryRaw.mockResolvedValueOnce([
      { failureCode: null, result: { narration: 'missing fields' }, status: 'completed' },
    ]);

    await expect(harness.router.executeRotaAnalyzeWorkflow(rotaAnalyzeInput())).rejects.toThrow(
      /malformed persisted result/,
    );
  });
});

function rotaAnalyzeInput() {
  return {
    actor: { correlationId: 'corr-rota-analyze', kind: 'user' as const, userId: managerId },
    correlationId: 'corr-rota-analyze',
    homeId,
    periodEnd: '2026-07-25T00:00:00.000Z',
    periodStart: '2026-07-18T00:00:00.000Z',
    requestedByUserId: managerId,
    tenantId,
  };
}

function retentionSweepInput() {
  return {
    actor: { correlationId: 'corr-retention', kind: 'user' as const, userId: managerId },
    correlationId: 'corr-retention',
    homeId,
    nowIso: '2026-07-18T01:00:00.000Z',
    tenantId,
  };
}

function rotaAnalyzeResult() {
  return {
    correlationId: 'corr-rota-analyze',
    gaps: [],
    narration: 'Coverage is complete.',
    periodEnd: '2026-07-25T00:00:00.000Z',
    periodStart: '2026-07-18T00:00:00.000Z',
    proposals: [],
    shifts: [],
  };
}

function createHarness(queryResults: readonly (readonly unknown[])[]) {
  const queryRaw = vi.fn();
  for (const result of queryResults) queryRaw.mockResolvedValueOnce(result);
  const transaction = { $queryRaw: queryRaw };
  const prisma = {
    withSystemContext: vi.fn(
      (_context: unknown, callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
    withTenantContext: vi.fn(
      (_context: unknown, callback: (client: typeof transaction) => Promise<unknown>) =>
        callback(transaction),
    ),
  };
  const temporal = {
    executeRotaAnalyzeWorkflow: vi.fn().mockResolvedValue(rotaAnalyzeResult()),
    signalApprovalDecision: vi.fn().mockResolvedValue(undefined),
    startPingWorkflow: vi.fn().mockResolvedValue({
      runId: 'temporal-ping-run',
      taskQueue: 'careos.phase0',
      workflowId: 'phase0-ping-temporal',
    }),
    startIncidentReportWorkflow: vi.fn((input: { readonly incidentId: string }) =>
      Promise.resolve({
        incidentId: input.incidentId,
        runId: 'temporal-incident-run',
        taskQueue: 'careos.incidents',
        workflowId: `incident-${input.incidentId}`,
      }),
    ),
    startDocIngestWorkflow: vi.fn((input: { readonly documentId: string }) =>
      Promise.resolve({
        documentId: input.documentId,
        runId: 'temporal-document-run',
        taskQueue: 'careos.documents',
        workflowId: `doc-ingest-${input.documentId}`,
      }),
    ),
    startSeriousIncidentExportWorkflow: vi.fn((input: { readonly bundleId: string }) =>
      Promise.resolve({
        bundleId: input.bundleId,
        runId: 'temporal-export-run',
        taskQueue: 'careos.export-bundles',
        workflowId: `serious-incident-export-${input.bundleId}`,
      }),
    ),
    startHandoverWorkflow: vi.fn((input: { readonly handoverId: string }) =>
      Promise.resolve({
        handoverId: input.handoverId,
        runId: 'temporal-handover-run',
        taskQueue: 'careos.handovers',
        workflowId: `handover-${input.handoverId}`,
      }),
    ),
    startEmailDraftWorkflow: vi.fn((input: { readonly emailDraftId: string }) =>
      Promise.resolve({
        emailDraftId: input.emailDraftId,
        runId: 'temporal-email-run',
        taskQueue: 'careos.emails',
        workflowId: `email-draft-${input.emailDraftId}`,
      }),
    ),
    startRotaPublishWorkflow: vi.fn((input: { readonly publicationId: string }) =>
      Promise.resolve({
        publicationId: input.publicationId,
        runId: 'temporal-rota-run',
        taskQueue: 'careos.rota',
        workflowId: `rota-publish-${input.publicationId}`,
      }),
    ),
    startRetentionSweepWorkflow: vi.fn((input: { readonly nowIso: string }) =>
      Promise.resolve({
        runId: 'temporal-retention-run',
        taskQueue: 'careos.retention',
        workflowId: `retention-sweep-${input.nowIso}`,
      }),
    ),
  };
  const durable = { raiseDecision: vi.fn().mockResolvedValue(undefined) };
  const documents = { start: vi.fn().mockResolvedValue(undefined) };
  const emailDrafts = { start: vi.fn().mockResolvedValue(undefined) };
  const exportBundles = { start: vi.fn().mockResolvedValue(undefined) };
  const handovers = { start: vi.fn().mockResolvedValue(undefined) };
  const incidents = {
    raiseCommand: vi.fn().mockResolvedValue(undefined),
    start: vi.fn().mockResolvedValue(undefined),
  };
  const ping = { start: vi.fn().mockResolvedValue(undefined) };
  const retention = { start: vi.fn().mockResolvedValue(undefined) };
  const rotaAnalyze = { execute: vi.fn().mockResolvedValue(undefined) };
  const rotaPublish = { start: vi.fn().mockResolvedValue(undefined) };
  const router = new WorkflowRuntimeRouter(
    temporal as unknown as ConstructorParameters<typeof WorkflowRuntimeRouter>[0],
    prisma as unknown as ConstructorParameters<typeof WorkflowRuntimeRouter>[1],
    durable,
    documents,
    emailDrafts,
    exportBundles,
    handovers,
    incidents,
    ping,
    retention,
    rotaAnalyze,
    rotaPublish,
  );
  return {
    documents,
    durable,
    emailDrafts,
    exportBundles,
    handovers,
    incidents,
    ping,
    prisma,
    queryRaw,
    retention,
    rotaAnalyze,
    rotaPublish,
    router,
    temporal,
  };
}
