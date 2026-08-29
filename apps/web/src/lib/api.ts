import { apiAuthorizationHeaders, getCareosServerSession } from './auth';

const API_URL = process.env.CAREOS_API_URL ?? 'http://api:3000';

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  if (process.env.CAREOS_E2E_STATIC_DATA === 'true') {
    const fixture = resolveE2eFixture(path);
    return fixture === undefined ? { ok: false, status: 404 } : { data: fixture as T, ok: true };
  }

  const session = await getCareosServerSession();
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');

  for (const [name, value] of Object.entries(apiAuthorizationHeaders(session))) {
    headers.set(name, value);
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    cache: 'no-store',
    headers,
  });

  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  return { data: (await response.json()) as T, ok: true };
}

const e2eResident = {
  arrivedAt: '2025-01-06T09:00:00.000Z',
  dateOfBirth: '2010-04-12T00:00:00.000Z',
  firstName: 'Jamie',
  id: '22222222-2222-4222-8222-222222222222',
  lastName: 'Connor',
  leftAt: null,
  preferredName: 'Jamie',
};

const e2eIncidentId = '44444444-4444-4444-8444-444444444444';
const e2eApprovedIncidentId = '48484848-4848-4848-8848-484848484848';
const e2eExportedIncidentId = '45454545-4545-4545-8545-454545454545';
const e2eIncidentDetail = {
  approval: {
    coveredRoles: ['manager'],
    id: e2eIncidentId,
    missingRoles: ['safeguarding_lead'],
    requiredRoles: ['manager', 'safeguarding_lead'],
    signaturesRecorded: 1,
    signaturesRequired: 2,
    signedByUserIds: ['55555555-5555-4555-8555-555555555555'],
    signedRoles: ['manager'],
    status: 'pending',
  },
  approvedAt: null,
  approvedByUserId: null,
  authorUserId: '55555555-5555-4555-8555-555555555555',
  createdAt: '2026-05-17T09:00:00.000Z',
  currentVersion: 2,
  exportBundle: null,
  exportedAt: null,
  formTemplate: {
    templateId: 'incident.safeguarding',
    title: 'Safeguarding Incident',
    version: 'v1',
  },
  id: e2eIncidentId,
  residentId: e2eResident.id,
  residentName: 'Jamie Connor',
  status: 'awaiting_approval',
  timeline: [
    {
      actorKind: 'user',
      id: '33333333-3333-4333-8333-333333333333',
      kind: 'incident',
      occurredAt: '2026-05-17T09:05:00.000Z',
      summary: 'Safeguarding incident routed for approval.',
    },
  ],
  updatedAt: '2026-05-17T09:05:00.000Z',
  versions: [
    {
      actorKind: 'user',
      actorUserId: '55555555-5555-4555-8555-555555555555',
      createdAt: '2026-05-17T09:00:00.000Z',
      formData: { category: 'neglect', residentId: e2eResident.id },
      missingMandatory: ['reportedToDslAt'],
      status: 'awaiting_fields',
      validationErrors: [],
      version: 1,
    },
    {
      actorKind: 'user',
      actorUserId: '55555555-5555-4555-8555-555555555555',
      createdAt: '2026-05-17T09:05:00.000Z',
      formData: {
        category: 'neglect',
        isChildAtImmediateRisk: true,
        reportedToDsl: true,
        residentId: e2eResident.id,
      },
      missingMandatory: [],
      status: 'awaiting_approval',
      validationErrors: [],
      version: 2,
    },
  ],
  workflowId: `incident-${e2eIncidentId}`,
} as const;

const e2eApprovedIncidentDetail = {
  ...e2eIncidentDetail,
  approval: {
    ...e2eIncidentDetail.approval,
    coveredRoles: ['manager', 'safeguarding_lead'],
    missingRoles: [],
    signaturesRecorded: 2,
    signedByUserIds: [
      '55555555-5555-4555-8555-555555555555',
      '56565656-5656-4565-8565-565656565656',
    ],
    signedRoles: ['manager', 'safeguarding_lead'],
    status: 'approved',
  },
  approvedAt: '2026-05-17T09:15:00.000Z',
  exportBundle: null,
  id: e2eApprovedIncidentId,
  status: 'approved',
  workflowId: `incident-${e2eApprovedIncidentId}`,
} as const;

const e2eExportedIncidentDetail = {
  ...e2eIncidentDetail,
  approval: {
    ...e2eIncidentDetail.approval,
    coveredRoles: ['manager', 'safeguarding_lead'],
    missingRoles: [],
    signaturesRecorded: 2,
    signedByUserIds: [
      '55555555-5555-4555-8555-555555555555',
      '56565656-5656-4565-8565-565656565656',
    ],
    signedRoles: ['manager', 'safeguarding_lead'],
    status: 'approved',
  },
  approvedAt: '2026-05-17T09:15:00.000Z',
  exportBundle: {
    createdAt: '2026-05-17T09:25:00.000Z',
    failureReason: null,
    id: '46464646-4646-4646-8646-464646464646',
    sizeBytes: 2048,
    status: 'ready',
    updatedAt: '2026-05-17T09:30:00.000Z',
  },
  exportedAt: '2026-05-17T09:20:00.000Z',
  id: e2eExportedIncidentId,
  status: 'exported',
  timeline: [
    {
      actorKind: 'user',
      id: '47474747-4747-4747-8747-474747474747',
      kind: 'incident',
      occurredAt: '2026-05-17T09:20:00.000Z',
      summary: 'Approved safeguarding incident exported to PDF.',
    },
  ],
  workflowId: `incident-${e2eExportedIncidentId}`,
} as const;

const e2eApprovalItems = [
  {
    coveredRoles: [],
    createdAt: '2026-05-17T09:15:00.000Z',
    currentUserHasSigned: false,
    emailDraft: {
      recipientEmail: 'manager@example.com',
      sensitivity: 'sensitive',
      status: 'needs_review',
      subject: 'Sensitive family update',
    },
    id: '77777777-7777-4777-8777-777777777777',
    missingRoles: ['manager', 'safeguarding_lead'],
    incident: null,
    requiredRoles: ['manager', 'safeguarding_lead'],
    requestedByUserId: '55555555-5555-4555-8555-555555555555',
    status: 'pending',
    signaturesRecorded: 0,
    signaturesRequired: 2,
    signedByUserIds: [],
    signedRoles: [],
    subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    subjectType: 'email_draft',
    summary: 'This sensitive family update needs manager review before any outbound handling.',
    title: 'Sensitive family update',
  },
  {
    coveredRoles: [],
    createdAt: '2026-05-17T09:20:00.000Z',
    currentUserHasSigned: false,
    emailDraft: {
      recipientEmail: 'safeguarding@example.com',
      sensitivity: 'sensitive',
      status: 'needs_review',
      subject: 'Safeguarding follow-up',
    },
    id: '88888888-8888-4888-8888-888888888888',
    missingRoles: ['manager', 'safeguarding_lead'],
    incident: null,
    requiredRoles: ['manager', 'safeguarding_lead'],
    requestedByUserId: '55555555-5555-4555-8555-555555555555',
    status: 'pending',
    signaturesRecorded: 0,
    signaturesRequired: 2,
    signedByUserIds: [],
    signedRoles: [],
    subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    subjectType: 'email_draft',
    summary: 'This safeguarding follow-up remains unsent until a manager rejects or approves it.',
    title: 'Safeguarding follow-up',
  },
  {
    coveredRoles: [],
    createdAt: '2026-05-17T09:25:00.000Z',
    currentUserHasSigned: false,
    emailDraft: null,
    id: '89898989-8989-4989-8989-898989898989',
    incident: {
      residentId: e2eResident.id,
      residentName: 'Jamie Connor',
      status: 'awaiting_approval',
      templateId: 'incident.behavioural',
    },
    missingRoles: ['manager'],
    requiredRoles: ['manager'],
    requestedByUserId: '55555555-5555-4555-8555-555555555555',
    status: 'pending',
    signaturesRecorded: 0,
    signaturesRequired: 1,
    signedByUserIds: [],
    signedRoles: [],
    subjectId: '89898989-1111-4111-8111-898989898989',
    subjectType: 'incident',
    summary: 'Routine behavioural incident ready for manager review.',
    title: 'Routine incident review',
  },
  {
    coveredRoles: ['manager'],
    createdAt: '2026-05-17T09:30:00.000Z',
    currentUserHasSigned: false,
    emailDraft: null,
    id: '90909090-9090-4090-8090-909090909090',
    incident: {
      residentId: e2eResident.id,
      residentName: 'Jamie Connor',
      status: 'awaiting_approval',
      templateId: 'incident.safeguarding',
    },
    missingRoles: ['safeguarding_lead'],
    requiredRoles: ['manager', 'safeguarding_lead'],
    requestedByUserId: '55555555-5555-4555-8555-555555555555',
    status: 'pending',
    signaturesRecorded: 1,
    signaturesRequired: 2,
    signedByUserIds: ['55555555-5555-4555-8555-555555555555'],
    signedRoles: ['manager'],
    subjectId: '90909090-1111-4111-8111-909090909090',
    subjectType: 'incident',
    summary: 'Manager signed; safeguarding-lead review remains outstanding.',
    title: 'Safeguarding second sign-off',
  },
] as const;

const e2eRotaOverview = {
  rules: [
    {
      active: true,
      id: 'rule-1',
      kind: 'min_staffing',
      name: 'Minimum support workers',
      parameters: { minHeadcount: 2, requiredRole: 'support_worker' },
    },
  ],
  shifts: [
    {
      assignedUserIds: ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
      endsAt: '2026-05-18T15:00:00.000Z',
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      minHeadcount: 2,
      requiredRole: 'support_worker',
      startsAt: '2026-05-18T07:00:00.000Z',
    },
  ],
} as const;

const e2eAutomationEvents = [
  {
    action: 'shift.reminder_dispatched',
    correlationId: 'corr-automation-1',
    id: '99999999-9999-4999-8999-999999999999',
    metadata: {},
    occurredAt: '2026-05-18T06:30:00.000Z',
    subjectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    subjectType: 'shift',
  },
] as const;

const e2eMattermostChannels = {
  mappings: [
    {
      channelId: 'home-channel-1',
      channelName: 'Ash House',
      id: '12121212-1212-4212-8212-121212121212',
      kind: 'home',
      updatedAt: '2026-05-18T06:00:00.000Z',
    },
  ],
} as const;

const e2eDocuments = {
  documents: [
    {
      createdAt: '2026-07-15T10:30:00.000Z',
      failureReason: 'docling-unavailable',
      id: '74747474-7474-4474-8474-747474747474',
      mimeType: 'application/pdf',
      objectKey:
        'tenants/11111111-1111-4111-8111-111111111111/homes/22222222-2222-4222-8222-222222222222/documents/74747474-7474-4474-8474-747474747474/Legacy-care-plan.pdf',
      originalFilename: 'Legacy care plan.pdf',
      sizeBytes: 4096,
      status: 'failed',
      updatedAt: '2026-07-15T10:31:00.000Z',
    },
  ],
} as const;

const e2eReportGeneratedAt = '2026-07-20T09:00:00.000Z';
const e2eReports = {
  home: {
    generatedAt: e2eReportGeneratedAt,
    groupBy: 'home',
    rows: [
      {
        approved: 9,
        exported: 6,
        key: '22222222-2222-4222-8222-222222222222',
        label: 'Ash House',
        total: 13,
      },
    ],
  },
  month: {
    generatedAt: e2eReportGeneratedAt,
    groupBy: 'month',
    rows: [
      { approved: 0, exported: 0, key: '2026-04', label: '2026-04', total: 0 },
      { approved: 3, exported: 2, key: '2026-05', label: '2026-05', total: 5 },
      { approved: 6, exported: 4, key: '2026-06', label: '2026-06', total: 9 },
      { approved: 2, exported: 1, key: '2026-07', label: '2026-07', total: 3 },
    ],
  },
  type: {
    generatedAt: e2eReportGeneratedAt,
    groupBy: 'type',
    rows: [
      {
        approved: 6,
        exported: 4,
        key: 'incident.behavioural',
        label: 'Behavioural Incident',
        total: 8,
      },
      {
        approved: 3,
        exported: 2,
        key: 'incident.safeguarding',
        label: 'Safeguarding Incident',
        total: 5,
      },
    ],
  },
} as const;

const e2eRetentionPolicies = [
  {
    action: 'soft_delete',
    createdAt: '2026-07-01T09:00:00.000Z',
    enabled: true,
    id: '71717171-7171-4171-8171-717171717171',
    recordType: 'incident',
    retentionDays: 2555,
    updatedAt: '2026-07-01T09:00:00.000Z',
  },
  {
    action: 'object_delete',
    createdAt: '2026-07-01T09:00:00.000Z',
    enabled: true,
    id: '72727272-7272-4272-8272-727272727272',
    recordType: 'attachment',
    retentionDays: 365,
    updatedAt: '2026-07-01T09:00:00.000Z',
  },
] as const;

const e2eRetentionRuns = [
  {
    action: 'soft_delete',
    affectedCount: 3,
    completedAt: '2026-07-15T02:00:03.000Z',
    failureReason: null,
    id: '73737373-7373-4373-8373-737373737373',
    recordType: 'incident',
    scannedCount: 3,
    startedAt: '2026-07-15T02:00:00.000Z',
    workflowId: 'retention-sweep-2026-07-15',
  },
] as const;

function resolveE2eFixture(path: string): unknown {
  if (path === '/approvals') {
    return { items: e2eApprovalItems };
  }
  if (path === '/documents') {
    return e2eDocuments;
  }
  if (path === '/incidents') {
    return {
      items: [
        {
          createdAt: e2eIncidentDetail.createdAt,
          currentVersion: e2eIncidentDetail.currentVersion,
          id: e2eIncidentDetail.id,
          residentId: e2eIncidentDetail.residentId,
          residentName: e2eIncidentDetail.residentName,
          status: e2eIncidentDetail.status,
          templateId: e2eIncidentDetail.formTemplate.templateId,
          templateTitle: e2eIncidentDetail.formTemplate.title,
          updatedAt: e2eIncidentDetail.updatedAt,
        },
        {
          createdAt: e2eExportedIncidentDetail.createdAt,
          currentVersion: e2eExportedIncidentDetail.currentVersion,
          id: e2eExportedIncidentDetail.id,
          residentId: e2eExportedIncidentDetail.residentId,
          residentName: e2eExportedIncidentDetail.residentName,
          status: e2eExportedIncidentDetail.status,
          templateId: e2eExportedIncidentDetail.formTemplate.templateId,
          templateTitle: e2eExportedIncidentDetail.formTemplate.title,
          updatedAt: e2eExportedIncidentDetail.updatedAt,
        },
      ],
    };
  }
  if (path === `/incidents/${e2eIncidentId}`) {
    return e2eIncidentDetail;
  }
  if (path === `/incidents/${e2eApprovedIncidentId}`) {
    return e2eApprovedIncidentDetail;
  }
  if (path === `/incidents/${e2eExportedIncidentId}`) {
    return e2eExportedIncidentDetail;
  }
  if (path === '/rota') {
    return e2eRotaOverview;
  }
  if (path.startsWith('/automations/recent')) {
    return { events: e2eAutomationEvents };
  }
  if (path === '/comms/mattermost/channels') {
    return e2eMattermostChannels;
  }
  if (path.startsWith('/reports/incidents/by-type')) {
    return e2eReports.type;
  }
  if (path.startsWith('/reports/incidents/by-home')) {
    return e2eReports.home;
  }
  if (path.startsWith('/reports/incidents/by-month')) {
    return e2eReports.month;
  }
  if (path === '/retention/policies') {
    return { policies: e2eRetentionPolicies };
  }
  if (path === '/retention/runs') {
    return { runs: e2eRetentionRuns };
  }
  if (path === '/residents') {
    return { items: [e2eResident] };
  }
  if (path === `/residents/${e2eResident.id}`) {
    return e2eResident;
  }
  if (path === `/residents/${e2eResident.id}/timeline`) {
    return [
      {
        actorKind: 'user',
        actorUserId: '11111111-1111-4111-8111-111111111111',
        id: '33333333-3333-4333-8333-333333333333',
        incidentId: e2eIncidentId,
        kind: 'incident.draft_created',
        occurredAt: '2026-05-17T09:00:00.000Z',
        payload: { status: 'draft' },
        summary: 'Behavioural incident draft created from staff prompt.',
        taskId: null,
      },
    ];
  }
  return undefined;
}
