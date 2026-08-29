import type {
  CreateApprovalRequestInput,
  CreateApprovalRequestResult,
  IncidentFollowUpActionDescriptor,
  PersistIncidentVersionInput,
} from '@careos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const stopAfterInitialPersistence = new Error('stop-after-initial-persistence');
const handlers = new Map<string, (...args: unknown[]) => unknown>();
let conditionBehavior: (predicate: () => boolean) => Promise<void> = () =>
  Promise.reject(stopAfterInitialPersistence);
const startChildMock = vi.hoisted(() => vi.fn());

interface ValidationResult {
  readonly errors: readonly { readonly message: string; readonly path: string }[];
  readonly missingMandatory: readonly string[];
  readonly valid: boolean;
}

const activityMocks = vi.hoisted(() => ({
  createApprovalRequest: vi.fn(
    (_input: CreateApprovalRequestInput): Promise<CreateApprovalRequestResult> =>
      Promise.resolve({
        approvalId: '55555555-5555-4555-8555-555555555555',
        requiredRoles: ['manager'],
        signatures: [],
        signaturesRequired: 1,
        status: 'pending',
      }),
  ),
  ensureIncidentFollowUpActions: vi.fn(
    (): Promise<readonly IncidentFollowUpActionDescriptor[]> => Promise.resolve([]),
  ),
  exportPdf: vi.fn(),
  persistIncidentVersion: vi.fn((_input: PersistIncidentVersionInput) =>
    Promise.resolve({ version: 1, versionId: 'version-1' }),
  ),
  routeForApproval: vi.fn(),
  resolveIncidentApprovalRequirement: vi.fn(() =>
    Promise.resolve({
      immediateRisk: false,
      level: 'confirm',
      requiredRoles: ['manager'],
      safeguarding: false,
      signaturesRequired: 1,
    }),
  ),
  validateAgainstSchema: vi.fn(
    (): Promise<ValidationResult> =>
      Promise.resolve({ errors: [], missingMandatory: [], valid: true }),
  ),
  writeAuditEvent: vi.fn(),
}));

vi.mock('@temporalio/workflow', () => ({
  ParentClosePolicy: { ABANDON: 'ABANDON' },
  condition: vi.fn((predicate: () => boolean) => conditionBehavior(predicate)),
  defineQuery: vi.fn((name: string) => name),
  defineSignal: vi.fn((name: string) => name),
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  patched: vi.fn(() => true),
  proxyActivities: vi.fn(() => activityMocks),
  setHandler: vi.fn((definition: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(definition, handler);
  }),
  startChild: startChildMock,
}));

import { IncidentReportWorkflow } from './incident-report.workflow.js';

const input = {
  authorUserId: '44444444-4444-4444-8444-444444444444',
  correlationId: 'corr-initial-validation',
  formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
  homeId: '22222222-2222-4222-8222-222222222222',
  incidentId: '55555555-5555-4555-8555-555555555555',
  initialFormData: { summary: 'partial draft' },
  residentId: '33333333-3333-4333-8333-333333333333',
  tenantId: '11111111-1111-4111-8111-111111111111',
} as const;

describe('IncidentReportWorkflow initial validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    conditionBehavior = () => Promise.reject(stopAfterInitialPersistence);
  });

  it('does not persist awaiting_approval while approval creation is delayed', async () => {
    let resolveApprovalCreation: ((value: CreateApprovalRequestResult) => void) | undefined;
    const approvalCreation = new Promise<CreateApprovalRequestResult>((resolve) => {
      resolveApprovalCreation = resolve;
    });
    activityMocks.createApprovalRequest.mockReturnValueOnce(approvalCreation);
    startChildMock.mockResolvedValueOnce({
      result: () =>
        Promise.resolve({
          approvalId: input.incidentId,
          requiredRoles: ['manager'],
          signatures: [
            {
              decidedAt: '2026-07-10T12:00:00.000Z',
              decision: 'rejected',
              role: 'manager',
              userId: '66666666-6666-4666-8666-666666666666',
            },
          ],
          signaturesRequired: 1,
          status: 'rejected',
          subjectId: input.incidentId,
          subjectType: 'incident',
        }),
    });
    conditionBehavior = (predicate) => {
      handlers.get('submitForApproval')?.({
        actor: { correlationId: 'corr-submit', kind: 'user', userId: input.authorUserId },
      });
      if (!predicate()) throw new Error('submit signal was not queued');
      return Promise.resolve();
    };

    const workflow = IncidentReportWorkflow(input);

    await vi.waitFor(() => expect(activityMocks.createApprovalRequest).toHaveBeenCalledTimes(1));
    expect(activityMocks.persistIncidentVersion).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'awaiting_approval' }),
    );
    expect(startChildMock).not.toHaveBeenCalled();

    resolveApprovalCreation?.({
      approvalId: input.incidentId,
      requiredRoles: ['manager'],
      signatures: [],
      signaturesRequired: 1,
      status: 'pending',
    });
    await expect(workflow).resolves.toBeUndefined();

    const approvalCreationOrder = activityMocks.createApprovalRequest.mock.invocationCallOrder[0];
    const awaitingApprovalCall = activityMocks.persistIncidentVersion.mock.calls.findIndex(
      ([payload]) => payload.status === 'awaiting_approval',
    );
    expect(approvalCreationOrder).toBeLessThan(
      activityMocks.persistIncidentVersion.mock.invocationCallOrder[awaitingApprovalCall] ?? 0,
    );
  });

  it('awaits the generic approval child before persisting approval and allowing export', async () => {
    const managerId = '66666666-6666-4666-8666-666666666666';
    startChildMock.mockResolvedValueOnce({
      result: () =>
        Promise.resolve({
          approvalId: input.incidentId,
          requiredRoles: ['manager'],
          signatures: [
            {
              decidedAt: '2026-07-10T12:00:00.000Z',
              decision: 'approved',
              role: 'manager',
              userId: managerId,
            },
          ],
          signaturesRequired: 1,
          status: 'approved',
          subjectId: input.incidentId,
          subjectType: 'incident',
        }),
    });
    activityMocks.exportPdf.mockResolvedValueOnce({
      objectKey: 'exports/incident.pdf',
      sha256: 'hash',
      sizeBytes: 100,
    });
    let conditionCount = 0;
    conditionBehavior = (predicate) => {
      if (conditionCount === 0) {
        handlers.get('submitForApproval')?.({
          actor: { correlationId: 'corr-submit', kind: 'user', userId: input.authorUserId },
        });
      } else {
        handlers.get('exportPdf')?.({
          actor: { correlationId: 'corr-export', kind: 'user', userId: managerId },
        });
      }
      conditionCount += 1;
      if (!predicate()) throw new Error('signal was not queued');
      return Promise.resolve();
    };

    await expect(IncidentReportWorkflow(input)).resolves.toBeUndefined();

    expect(activityMocks.resolveIncidentApprovalRequirement).toHaveBeenCalledTimes(1);
    expect(startChildMock).toHaveBeenCalledWith(
      'ApprovalRoutingWorkflow',
      expect.objectContaining({
        args: [
          expect.objectContaining({
            approvalId: input.incidentId,
            requiredRoles: ['manager'],
            signaturesRequired: 1,
            subjectType: 'incident',
          }),
        ],
        taskQueue: 'careos.approvals',
        workflowId: `approval-${input.incidentId}`,
      }),
    );
    expect(activityMocks.persistIncidentVersion).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'approved' }),
    );
    expect(activityMocks.writeAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'incident.approved' }),
    );
    expect(activityMocks.exportPdf).toHaveBeenCalledTimes(1);
  });

  it('starts policy-owned follow-ups after an approved safeguarding decision', async () => {
    const safeguardingId = '77777777-7777-4777-8777-777777777777';
    const followUp = {
      actionId: '88888888-8888-4888-8888-888888888888',
      attempt: 1,
      kind: 'export_bundle' as const,
      targetId: '99999999-9999-4999-8999-999999999999',
      workflowId: 'incident-follow-up-88888888-8888-4888-8888-888888888888-attempt-1',
    };
    startChildMock
      .mockResolvedValueOnce({
        result: () =>
          Promise.resolve({
            approvalId: input.incidentId,
            requiredRoles: ['manager', 'safeguarding_lead'],
            signatures: [
              {
                decidedAt: '2026-07-10T12:00:00.000Z',
                decision: 'approved',
                role: 'manager',
                userId: input.authorUserId,
              },
              {
                decidedAt: '2026-07-10T12:01:00.000Z',
                decision: 'approved',
                role: 'safeguarding_lead',
                userId: safeguardingId,
              },
            ],
            signaturesRequired: 2,
            status: 'approved',
            subjectId: input.incidentId,
            subjectType: 'incident',
          }),
      })
      .mockResolvedValueOnce({});
    activityMocks.resolveIncidentApprovalRequirement.mockResolvedValueOnce({
      immediateRisk: true,
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      safeguarding: true,
      signaturesRequired: 2,
    });
    activityMocks.ensureIncidentFollowUpActions.mockResolvedValueOnce([followUp]);
    activityMocks.exportPdf.mockResolvedValueOnce({
      objectKey: 'exports/incident.pdf',
      sha256: 'hash',
      sizeBytes: 100,
    });
    let conditionCount = 0;
    conditionBehavior = (predicate) => {
      if (conditionCount === 0) {
        handlers.get('submitForApproval')?.({
          actor: { correlationId: 'corr-submit', kind: 'user', userId: input.authorUserId },
        });
      } else {
        handlers.get('exportPdf')?.({
          actor: { correlationId: 'corr-export', kind: 'user', userId: safeguardingId },
        });
      }
      conditionCount += 1;
      if (!predicate()) throw new Error('signal was not queued');
      return Promise.resolve();
    };

    await expect(IncidentReportWorkflow(input)).resolves.toBeUndefined();

    expect(activityMocks.ensureIncidentFollowUpActions).toHaveBeenCalledWith({
      actor: { correlationId: 'corr-submit', kind: 'user', userId: safeguardingId },
      homeId: input.homeId,
      immediateRisk: true,
      incidentId: input.incidentId,
      orchestrationName: 'IncidentFollowUpActionWorkflow',
      runtime: 'temporal',
      safeguarding: true,
      tenantId: input.tenantId,
    });
    expect(startChildMock).toHaveBeenNthCalledWith(2, 'IncidentFollowUpActionWorkflow', {
      args: [
        {
          actionId: followUp.actionId,
          attempt: 1,
          correlationId: 'corr-submit',
          homeId: input.homeId,
          incidentId: input.incidentId,
          kind: 'export_bundle',
          requestedByUserId: safeguardingId,
          targetId: followUp.targetId,
          tenantId: input.tenantId,
        },
      ],
      parentClosePolicy: 'ABANDON',
      taskQueue: 'careos.incidents',
      workflowId: followUp.workflowId,
    });
  });

  it('persists a vetoed incident as rejected and never exports it', async () => {
    const safeguardingId = '77777777-7777-4777-8777-777777777777';
    startChildMock.mockResolvedValueOnce({
      result: () =>
        Promise.resolve({
          approvalId: input.incidentId,
          requiredRoles: ['manager', 'safeguarding_lead'],
          signatures: [
            {
              decidedAt: '2026-07-10T12:00:00.000Z',
              decision: 'rejected',
              role: 'safeguarding_lead',
              userId: safeguardingId,
            },
          ],
          signaturesRequired: 2,
          status: 'rejected',
          subjectId: input.incidentId,
          subjectType: 'incident',
        }),
    });
    activityMocks.resolveIncidentApprovalRequirement.mockResolvedValueOnce({
      immediateRisk: true,
      level: 'dual_sign_off',
      requiredRoles: ['manager', 'safeguarding_lead'],
      safeguarding: true,
      signaturesRequired: 2,
    });
    conditionBehavior = (predicate) => {
      handlers.get('submitForApproval')?.({
        actor: { correlationId: 'corr-submit', kind: 'user', userId: input.authorUserId },
      });
      if (!predicate()) throw new Error('submit signal was not queued');
      return Promise.resolve();
    };

    await expect(IncidentReportWorkflow(input)).resolves.toBeUndefined();

    expect(activityMocks.persistIncidentVersion).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'rejected' }),
    );
    expect(activityMocks.writeAuditEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'incident.rejected' }),
    );
    expect(activityMocks.exportPdf).not.toHaveBeenCalled();
  });

  it('validates before persisting the initial version', async () => {
    activityMocks.validateAgainstSchema.mockResolvedValueOnce({
      errors: [],
      missingMandatory: [],
      valid: true,
    });

    await expect(IncidentReportWorkflow(input)).rejects.toBe(stopAfterInitialPersistence);

    expect(activityMocks.validateAgainstSchema.mock.invocationCallOrder[0]).toBeLessThan(
      activityMocks.persistIncidentVersion.mock.invocationCallOrder[0] ?? 0,
    );
    expect(activityMocks.persistIncidentVersion).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft', validationErrors: [] }),
    );
  });

  it('persists invalid initial data as awaiting_fields with normalized evidence', async () => {
    const errors = [{ message: "must have required property 'residentId'", path: '/residentId' }];
    activityMocks.validateAgainstSchema.mockResolvedValueOnce({
      errors,
      missingMandatory: ['residentId'],
      valid: false,
    });

    await expect(IncidentReportWorkflow(input)).rejects.toBe(stopAfterInitialPersistence);

    expect(activityMocks.validateAgainstSchema.mock.invocationCallOrder[0]).toBeLessThan(
      activityMocks.persistIncidentVersion.mock.invocationCallOrder[0] ?? 0,
    );
    expect(activityMocks.persistIncidentVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        missingMandatory: ['residentId'],
        status: 'awaiting_fields',
        validationErrors: errors,
      }),
    );
  });
});
