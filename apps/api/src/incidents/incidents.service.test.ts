import { incidentWorkflowId, type IncidentActor } from '@careos/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApproveIncidentSchema,
  CreateIncidentSchema,
  DraftIncidentFromTextSchema,
  ExportIncidentSchema,
  SubmitIncidentSchema,
  UpdateIncidentSchema,
} from './dto.js';
import { IncidentsService } from './incidents.service.js';

const tenantId = '11111111-1111-4111-8111-111111111111';
const homeId = '22222222-2222-4222-8222-222222222222';
const residentId = '33333333-3333-4333-8333-333333333333';
const authorUserId = '44444444-4444-4444-8444-444444444444';
const correlationId = 'corr-123';

const actor: IncidentActor = {
  correlationId,
  kind: 'user',
  userId: authorUserId,
};

const requestContext = {
  actor,
  authorUserId,
  correlationId,
  homeId,
  tenantId,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Incident DTO schemas', () => {
  it('CreateIncident requires uuid resident and template descriptor', () => {
    const ok = CreateIncidentSchema.safeParse({
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      residentId,
    });
    expect(ok.success).toBe(true);

    const bad = CreateIncidentSchema.safeParse({
      formTemplate: { templateId: '', version: 'v1' },
      residentId: 'not-a-uuid',
    });
    expect(bad.success).toBe(false);
  });

  it('UpdateIncident requires a formData object', () => {
    expect(UpdateIncidentSchema.safeParse({ formData: { hello: 1 } }).success).toBe(true);
    expect(UpdateIncidentSchema.safeParse({}).success).toBe(false);
  });

  it('DraftIncidentFromText requires a bounded narrative, resident, and template', () => {
    expect(
      DraftIncidentFromTextSchema.safeParse({
        free_text: 'A factual incident narrative.',
        resident_id: residentId,
        template_id: 'incident.behavioural',
      }).success,
    ).toBe(true);
    expect(
      DraftIncidentFromTextSchema.safeParse({
        free_text: '',
        resident_id: 'not-a-uuid',
        template_id: '',
      }).success,
    ).toBe(false);
  });

  it('Submit/Export are strict empty bodies; Approve allows optional note', () => {
    expect(SubmitIncidentSchema.safeParse({}).success).toBe(true);
    expect(SubmitIncidentSchema.safeParse({ extra: true }).success).toBe(false);
    expect(ExportIncidentSchema.safeParse({}).success).toBe(true);
    expect(ApproveIncidentSchema.safeParse({ note: 'lgtm' }).success).toBe(true);
    expect(ApproveIncidentSchema.safeParse({ note: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('IncidentsService', () => {
  function createService(): {
    readonly service: IncidentsService;
    readonly temporal: ReturnType<typeof createTemporalMock>;
    readonly prisma: ReturnType<typeof createPrismaMock>;
  } {
    const temporal = createTemporalMock();
    const prisma = createPrismaMock();
    const storage = {
      incidentsBucket: 'careos-incidents',
      presignedIncidentDownload: vi.fn(() => Promise.resolve('https://minio.test/signed')),
    };
    const service = new IncidentsService(
      prisma as unknown as ConstructorParameters<typeof IncidentsService>[0],
      temporal as unknown as ConstructorParameters<typeof IncidentsService>[1],
      storage as unknown as ConstructorParameters<typeof IncidentsService>[2],
    );
    return { prisma, service, temporal };
  }

  it('create() preflights visibility, starts the workflow, and never writes through Prisma', async () => {
    const { service, temporal, prisma } = createService();
    const result = await service.create(
      {
        formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
        residentId,
      },
      requestContext,
    );

    expect(temporal.startIncidentReportWorkflow).toHaveBeenCalledTimes(1);
    const args = temporal.startIncidentReportWorkflow.mock.calls[0]?.[0] as
      | { incidentId: string; tenantId: string; homeId: string }
      | undefined;
    expect(args).toMatchObject({
      authorUserId,
      correlationId,
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      homeId,
      initialFormData: { residentId },
      residentId,
      tenantId,
    });
    expect(args?.incidentId).toMatch(/^[0-9a-f-]{36}$/);

    expect(result.status).toBe('draft');
    expect(result.workflowId).toBe(incidentWorkflowId(result.id));

    expect(prisma.formTemplate.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.resident.findFirst).toHaveBeenCalledTimes(1);

    // The hard rule: zero direct DB writes from the controller path.
    expect(prisma.incident.create).not.toHaveBeenCalled();
    expect(prisma.incident.update).not.toHaveBeenCalled();
    expect(prisma.timelineEntry.create).not.toHaveBeenCalled();
  });

  it('draftFromText() forwards trusted context to Hermes without starting Temporal', async () => {
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      if (!(input instanceof URL)) throw new Error('Expected a URL input.');
      expect(input.href).toBe('http://hermes:8080/mcp');
      expect(init?.headers).toMatchObject({
        'x-careos-correlation-id': correlationId,
        'x-careos-home-id': homeId,
        'x-careos-tenant-id': tenantId,
        'x-careos-user-id': authorUserId,
      });
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body.');
      const body = JSON.parse(init.body) as {
        readonly params: { readonly arguments: Record<string, unknown> };
      };
      expect(body.params.arguments).toEqual({
        correlation_id: correlationId,
        free_text: 'A factual incident narrative.',
        resident_id: residentId,
        template_id: 'incident.behavioural',
      });
      expect(body.params.arguments).not.toHaveProperty('tenant_id');
      expect(body.params.arguments).not.toHaveProperty('user_id');
      return Promise.resolve(
        Response.json({
          id: 'rpc-1',
          jsonrpc: '2.0',
          result: {
            content: [
              {
                text: JSON.stringify({
                  confidence: 0.86,
                  form_data: { residentId, summary: 'A factual incident narrative.' },
                  missing_mandatory: ['occurredAt'],
                }),
                type: 'text',
              },
            ],
          },
        }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { prisma, service, temporal } = createService();

    await expect(
      service.draftFromText(
        {
          free_text: 'A factual incident narrative.',
          resident_id: residentId,
          template_id: 'incident.behavioural',
        },
        requestContext,
      ),
    ).resolves.toEqual({
      confidence: 0.86,
      form_data: { residentId, summary: 'A factual incident narrative.' },
      missing_mandatory: ['occurredAt'],
    });
    expect(prisma.formTemplate.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.resident.findFirst).toHaveBeenCalledTimes(1);
    expect(temporal.startIncidentReportWorkflow).not.toHaveBeenCalled();
  });

  it('does not start Temporal for an unregistered template or invisible resident', async () => {
    const unregistered = createService();
    unregistered.prisma.formTemplate.findFirst.mockResolvedValue(null);
    await expect(
      unregistered.service.create(
        {
          formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
          residentId,
        },
        requestContext,
      ),
    ).rejects.toThrow(/not registered/i);
    expect(unregistered.temporal.startIncidentReportWorkflow).not.toHaveBeenCalled();

    const invisible = createService();
    invisible.prisma.resident.findFirst.mockResolvedValue(null);
    await expect(
      invisible.service.create(
        {
          formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
          residentId,
        },
        requestContext,
      ),
    ).rejects.toThrow(/not found in the active home/i);
    expect(invisible.temporal.startIncidentReportWorkflow).not.toHaveBeenCalled();
  });

  it('update() routes to the updateDraft signal with the actor envelope', async () => {
    const { service, temporal } = createService();
    const incidentId = '55555555-5555-4555-8555-555555555555';
    await service.update(
      incidentId,
      { formData: { summary: 'Updated factual summary.' } },
      requestContext,
    );

    expect(temporal.signalUpdateDraft).toHaveBeenCalledWith(
      incidentId,
      {
        actor,
        formData: { residentId, summary: 'Updated factual summary.' },
      },
      { homeId, tenantId },
    );
  });

  it('does not start or signal Temporal for malformed provided form fields', async () => {
    const createHarness = createService();
    await expect(
      createHarness.service.create(
        {
          formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
          initialFormData: { occurredAt: 'not-a-date' },
          residentId,
        },
        requestContext,
      ),
    ).rejects.toThrow(/failed schema validation/i);
    expect(createHarness.temporal.startIncidentReportWorkflow).not.toHaveBeenCalled();

    const updateHarness = createService();
    await expect(
      updateHarness.service.update(
        '55555555-5555-4555-8555-555555555555',
        { formData: { rogueField: true } },
        requestContext,
      ),
    ).rejects.toThrow(/failed schema validation/i);
    expect(updateHarness.temporal.signalUpdateDraft).not.toHaveBeenCalled();
  });

  it('submit and approved export each dispatch the correct signal', async () => {
    const { service, temporal } = createService();
    const incidentId = '66666666-6666-4666-8666-666666666666';

    await service.submit(incidentId, requestContext);
    expect(temporal.signalSubmitForApproval).toHaveBeenCalledWith(
      incidentId,
      { actor },
      { homeId, tenantId },
    );

    await service.exportPdf(incidentId, requestContext);
    expect(temporal.signalExport).toHaveBeenCalledWith(incidentId, { actor }, { homeId, tenantId });
  });

  it('rejects PDF export before approval without signaling Temporal', async () => {
    const { prisma, service, temporal } = createService();
    prisma.incident.findFirst.mockResolvedValueOnce({ status: 'awaiting_approval' });

    await expect(
      service.exportPdf('66666666-6666-4666-8666-666666666666', requestContext),
    ).rejects.toThrow(/only approved incidents/i);
    expect(temporal.signalExport).not.toHaveBeenCalled();
  });

  it('findById() throws when the row is missing', async () => {
    const { service, prisma } = createService();
    prisma.incident.findFirst.mockResolvedValue(null);
    await expect(
      service.findById('77777777-7777-4777-8777-777777777777', requestContext),
    ).rejects.toThrow(/not found/);
    expect(prisma.withTenantContext).toHaveBeenCalledWith(
      { actor, homeId, tenantId },
      expect.any(Function),
    );
  });
});

function createTemporalMock(): {
  readonly startIncidentReportWorkflow: ReturnType<typeof vi.fn>;
  readonly signalUpdateDraft: ReturnType<typeof vi.fn>;
  readonly signalSubmitForApproval: ReturnType<typeof vi.fn>;
  readonly signalApprove: ReturnType<typeof vi.fn>;
  readonly signalExport: ReturnType<typeof vi.fn>;
  readonly queryIncidentState: ReturnType<typeof vi.fn>;
} {
  return {
    queryIncidentState: vi.fn(),
    signalApprove: vi.fn().mockResolvedValue(undefined),
    signalExport: vi.fn().mockResolvedValue(undefined),
    signalSubmitForApproval: vi.fn().mockResolvedValue(undefined),
    signalUpdateDraft: vi.fn().mockResolvedValue(undefined),
    startIncidentReportWorkflow: vi.fn((input: { incidentId: string }) => ({
      incidentId: input.incidentId,
      runId: 'run-1',
      taskQueue: 'careos.incidents',
      workflowId: incidentWorkflowId(input.incidentId),
    })),
  };
}

function createPrismaMock(): {
  readonly withTenantContext: ReturnType<typeof vi.fn>;
  readonly formTemplate: {
    readonly findFirst: ReturnType<typeof vi.fn>;
  };
  readonly incident: {
    readonly findFirst: ReturnType<typeof vi.fn>;
    readonly findUnique: ReturnType<typeof vi.fn>;
    readonly create: ReturnType<typeof vi.fn>;
    readonly update: ReturnType<typeof vi.fn>;
  };
  readonly timelineEntry: {
    readonly findMany: ReturnType<typeof vi.fn>;
    readonly create: ReturnType<typeof vi.fn>;
  };
  readonly resident: {
    readonly findFirst: ReturnType<typeof vi.fn>;
  };
} {
  const formTemplate = {
    findFirst: vi.fn().mockResolvedValue({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
  };
  const incident = {
    create: vi.fn(),
    findFirst: vi.fn().mockResolvedValue({
      formTemplate: { templateId: 'incident.behavioural', version: 'v1' },
      residentId,
      status: 'approved',
    }),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const timelineEntry = {
    create: vi.fn(),
    findMany: vi.fn(),
  };
  const resident = {
    findFirst: vi.fn().mockResolvedValue({ id: residentId }),
  };

  return {
    formTemplate,
    incident,
    resident,
    timelineEntry,
    withTenantContext: vi.fn(
      (
        _context: unknown,
        callback: (transaction: {
          formTemplate: typeof formTemplate;
          incident: typeof incident;
          resident: typeof resident;
          timelineEntry: typeof timelineEntry;
        }) => unknown,
      ) => callback({ formTemplate, incident, resident, timelineEntry }),
    ),
  };
}
