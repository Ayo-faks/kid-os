import { OrchestrationStatus } from '@microsoft/durabletask-js';
import { describe, expect, it, vi } from 'vitest';

import {
  HANDOVER_DUE_ORCHESTRATION_VERSION,
  HANDOVER_DUE_SCHEDULE_ORCHESTRATOR,
} from './handover-due-reminder.contracts.js';
import {
  MISSING_FIELDS_ORCHESTRATION_VERSION,
  MISSING_FIELDS_SCHEDULE_ORCHESTRATOR,
} from './missing-fields-audit.contracts.js';
import {
  RETENTION_ORCHESTRATION_VERSION,
  RETENTION_SCHEDULE_ORCHESTRATOR,
} from './retention.contracts.js';
import {
  SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
  SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
} from './safeguarding-digest.contracts.js';
import {
  SHIFT_REMINDER_ORCHESTRATION_VERSION,
  SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
} from './shift-reminder.contracts.js';
import {
  ensureDurableHandoverDueSchedule,
  ensureDurableMissingFieldsSchedule,
  ensureDurableRetentionSchedule,
  ensureDurableSafeguardingDigestSchedule,
  ensureDurableShiftReminderSchedule,
  getDurableRuntimeConfig,
  getDurableShiftReminderRuntimeConfig,
  HANDOVER_DUE_SCHEDULE_INSTANCE_ID,
  isolateDurableScheduleRegistration,
  MISSING_FIELDS_SCHEDULE_INSTANCE_ID,
  RETENTION_SCHEDULE_INSTANCE_ID,
  SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID,
  SHIFT_REMINDER_SCHEDULE_INSTANCE_ID,
} from './worker.js';

describe('Durable Shift Reminder worker configuration', () => {
  it('keeps Temporal as the default runtime', () => {
    expect(getDurableShiftReminderRuntimeConfig({})).toEqual({ enabled: false });
  });

  it('requires a connection string when Durable owns shift reminders', () => {
    expect(() =>
      getDurableShiftReminderRuntimeConfig({ WORKFLOW_RUNTIME_SHIFT_REMINDERS: 'durable' }),
    ).toThrow(/DURABLE_TASK_SCHEDULER_CONNECTION_STRING/);
  });

  it('accepts the explicit Durable configuration', () => {
    expect(
      getDurableShiftReminderRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_SHIFT_REMINDERS: 'durable',
      }),
    ).toEqual({
      connectionString: 'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
      enabled: true,
    });
  });
});

describe('Durable worker feature configuration', () => {
  it('keeps every workflow on Temporal by default', () => {
    expect(getDurableRuntimeConfig({})).toEqual({
      enabled: false,
      features: {
        approvals: false,
        documents: false,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        missingFieldsAudit: false,
        ping: false,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: false,
        safeguardingDigest: false,
        shiftReminders: false,
      },
    });
  });

  it('starts the shared Durable worker for approval routing alone', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_APPROVALS: 'durable',
      }),
    ).toEqual({
      connectionString: 'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
      enabled: true,
      features: {
        approvals: true,
        documents: false,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        missingFieldsAudit: false,
        ping: false,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: false,
        safeguardingDigest: false,
        shiftReminders: false,
      },
    });
  });

  it('requires scheduler configuration for any Durable feature', () => {
    expect(() => getDurableRuntimeConfig({ WORKFLOW_RUNTIME_APPROVALS: 'durable' })).toThrow(
      /DURABLE_TASK_SCHEDULER_CONNECTION_STRING/,
    );
  });

  it('rejects unknown runtime names', () => {
    expect(() => getDurableRuntimeConfig({ WORKFLOW_RUNTIME_APPROVALS: 'hybrid' })).toThrow(
      /WORKFLOW_RUNTIME_APPROVALS/,
    );
  });

  it('starts the shared Durable worker for incidents and their Approval child', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_APPROVALS: 'durable',
        WORKFLOW_RUNTIME_INCIDENTS: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: true,
        documents: false,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: true,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: false,
        shiftReminders: false,
      },
    });
  });

  it('rejects Durable incidents without their Durable Approval child', () => {
    expect(() =>
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_INCIDENTS: 'durable',
      }),
    ).toThrow(/WORKFLOW_RUNTIME_APPROVALS/);
  });

  it('starts the shared Durable worker for document ingestion independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_DOCUMENTS: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: false,
        documents: true,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: false,
        shiftReminders: false,
      },
    });
  });

  it('starts the shared Durable worker for serious incident export independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_EXPORT_BUNDLES: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: false,
        documents: false,
        emailDrafts: false,
        exportBundles: true,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: false,
        shiftReminders: false,
      },
    });
  });

  it('starts the shared Durable worker for handovers independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_HANDOVERS: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: false,
        documents: false,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: true,
        incidents: false,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: false,
        shiftReminders: false,
      },
    });
  });

  it('starts Durable email drafts with their Durable Approval dependency', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_APPROVALS: 'durable',
        WORKFLOW_RUNTIME_EMAIL_DRAFTS: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: true,
        documents: false,
        emailDrafts: true,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: false,
        shiftReminders: false,
      },
    });
  });

  it('rejects Durable email drafts without Durable Approval routing', () => {
    expect(() =>
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_EMAIL_DRAFTS: 'durable',
      }),
    ).toThrow(/WORKFLOW_RUNTIME_APPROVALS/);
  });

  it('starts the shared Durable worker for Rota Publish independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_ROTA_PUBLISH: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: false,
        documents: false,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        retention: false,
        rotaAnalyze: false,
        rotaPublish: true,
        shiftReminders: false,
      },
    });
  });

  it('starts the shared Durable worker for Rota Analyze independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_ROTA_ANALYZE: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: false,
        documents: false,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        retention: false,
        rotaAnalyze: true,
        rotaPublish: false,
        shiftReminders: false,
      },
    });
  });

  it('starts the shared Durable worker for Retention independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_RETENTION: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: {
        approvals: false,
        documents: false,
        emailDrafts: false,
        exportBundles: false,
        handoverDueReminders: false,
        handovers: false,
        incidents: false,
        retention: true,
        rotaAnalyze: false,
        rotaPublish: false,
        shiftReminders: false,
      },
    });
  });

  it('starts the shared Durable worker for Handover Due reminders independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_HANDOVER_DUE_REMINDERS: 'durable',
      }),
    ).toMatchObject({
      enabled: true,
      features: { handoverDueReminders: true },
    });
  });

  it('starts the shared Durable worker for Missing Fields audit independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_MISSING_FIELDS_AUDIT: 'durable',
      }),
    ).toMatchObject({ enabled: true, features: { missingFieldsAudit: true } });
  });

  it('starts the shared Durable worker for Safeguarding Digest independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_SAFEGUARDING_DIGEST: 'durable',
      }),
    ).toMatchObject({ enabled: true, features: { safeguardingDigest: true } });
  });

  it('starts the shared Durable worker for Ping independently', () => {
    expect(
      getDurableRuntimeConfig({
        DURABLE_TASK_SCHEDULER_CONNECTION_STRING:
          'Endpoint=http://dts-emulator:8080;Authentication=None;TaskHub=default',
        WORKFLOW_RUNTIME_PING: 'durable',
      }),
    ).toMatchObject({ enabled: true, features: { ping: true } });
  });
});

describe('ensureDurableShiftReminderSchedule', () => {
  it('starts the versioned singleton when it is absent', async () => {
    const scheduleNewOrchestration = vi.fn().mockResolvedValue(SHIFT_REMINDER_SCHEDULE_INSTANCE_ID);
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue(undefined),
      scheduleNewOrchestration,
    };

    await expect(ensureDurableShiftReminderSchedule(client)).resolves.toBe('created');
    expect(scheduleNewOrchestration).toHaveBeenCalledWith(
      SHIFT_REMINDER_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: SHIFT_REMINDER_SCHEDULE_INSTANCE_ID,
        version: SHIFT_REMINDER_ORCHESTRATION_VERSION,
      },
    );
  });

  it.each([
    OrchestrationStatus.PENDING,
    OrchestrationStatus.RUNNING,
    OrchestrationStatus.SUSPENDED,
    OrchestrationStatus.CONTINUED_AS_NEW,
  ])('reuses the active singleton in status %s', async (runtimeStatus) => {
    const scheduleNewOrchestration = vi.fn();
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue({ runtimeStatus }),
      scheduleNewOrchestration,
    };

    await expect(ensureDurableShiftReminderSchedule(client)).resolves.toBe('existing');
    expect(scheduleNewOrchestration).not.toHaveBeenCalled();
  });

  it('reconciles another replica winning the singleton start race', async () => {
    const startError = new Error('instance already exists');
    const getOrchestrationState = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING });
    const client = {
      getOrchestrationState,
      scheduleNewOrchestration: vi.fn().mockRejectedValue(startError),
    };

    await expect(ensureDurableShiftReminderSchedule(client)).resolves.toBe('existing');
    expect(getOrchestrationState).toHaveBeenCalledTimes(2);
  });

  it('refuses to reuse a terminal singleton ID', async () => {
    const client = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.FAILED }),
      scheduleNewOrchestration: vi.fn(),
    };

    await expect(ensureDurableShiftReminderSchedule(client)).rejects.toThrow(
      /Deploy a new versioned singleton ID/,
    );
  });
});

describe('isolateDurableScheduleRegistration', () => {
  it('preserves successful registration outcomes', async () => {
    await expect(
      isolateDurableScheduleRegistration('shift-reminder', () => Promise.resolve('created')),
    ).resolves.toBe('created');
  });

  it('reports schedule degradation without terminating shared workflow processing', async () => {
    const reportError = vi.fn();

    await expect(
      isolateDurableScheduleRegistration(
        'shift-reminder',
        () => Promise.reject(new Error('terminal singleton history')),
        reportError,
      ),
    ).resolves.toBe('degraded');
    expect(reportError).toHaveBeenCalledWith(
      '[worker] Durable shift-reminder schedule degraded: terminal singleton history\n',
    );
  });
});

describe('ensureDurableRetentionSchedule', () => {
  it('starts the versioned singleton when absent', async () => {
    const scheduleNewOrchestration = vi.fn().mockResolvedValue(RETENTION_SCHEDULE_INSTANCE_ID);
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue(undefined),
      scheduleNewOrchestration,
    };

    await expect(ensureDurableRetentionSchedule(client)).resolves.toBe('created');
    expect(scheduleNewOrchestration).toHaveBeenCalledWith(
      RETENTION_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: RETENTION_SCHEDULE_INSTANCE_ID,
        version: RETENTION_ORCHESTRATION_VERSION,
      },
    );
  });

  it('reconciles a concurrent singleton start', async () => {
    const client = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING }),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(new Error('already exists')),
    };

    await expect(ensureDurableRetentionSchedule(client)).resolves.toBe('existing');
  });

  it('refuses a terminal singleton history', async () => {
    const client = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.COMPLETED }),
      scheduleNewOrchestration: vi.fn(),
    };

    await expect(ensureDurableRetentionSchedule(client)).rejects.toThrow(
      /Deploy a new versioned singleton ID/,
    );
  });
});

describe('ensureDurableHandoverDueSchedule', () => {
  it('starts the versioned singleton when absent', async () => {
    const scheduleNewOrchestration = vi.fn().mockResolvedValue(HANDOVER_DUE_SCHEDULE_INSTANCE_ID);
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue(undefined),
      scheduleNewOrchestration,
    };

    await expect(ensureDurableHandoverDueSchedule(client)).resolves.toBe('created');
    expect(scheduleNewOrchestration).toHaveBeenCalledWith(
      HANDOVER_DUE_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: HANDOVER_DUE_SCHEDULE_INSTANCE_ID,
        version: HANDOVER_DUE_ORCHESTRATION_VERSION,
      },
    );
  });

  it('reconciles a concurrent singleton start and refuses terminal history', async () => {
    const raced = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING }),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(new Error('already exists')),
    };
    await expect(ensureDurableHandoverDueSchedule(raced)).resolves.toBe('existing');

    const terminal = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.FAILED }),
      scheduleNewOrchestration: vi.fn(),
    };
    await expect(ensureDurableHandoverDueSchedule(terminal)).rejects.toThrow(
      /Deploy a new versioned singleton ID/,
    );
  });
});

describe('ensureDurableMissingFieldsSchedule', () => {
  it('starts the versioned singleton when absent', async () => {
    const scheduleNewOrchestration = vi.fn().mockResolvedValue(MISSING_FIELDS_SCHEDULE_INSTANCE_ID);
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue(undefined),
      scheduleNewOrchestration,
    };
    await expect(ensureDurableMissingFieldsSchedule(client)).resolves.toBe('created');
    expect(scheduleNewOrchestration).toHaveBeenCalledWith(
      MISSING_FIELDS_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: MISSING_FIELDS_SCHEDULE_INSTANCE_ID,
        version: MISSING_FIELDS_ORCHESTRATION_VERSION,
      },
    );
  });

  it('reconciles a concurrent start and refuses terminal history', async () => {
    const raced = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING }),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(new Error('already exists')),
    };
    await expect(ensureDurableMissingFieldsSchedule(raced)).resolves.toBe('existing');

    const terminal = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.FAILED }),
      scheduleNewOrchestration: vi.fn(),
    };
    await expect(ensureDurableMissingFieldsSchedule(terminal)).rejects.toThrow(
      /Deploy a new versioned singleton ID/,
    );
  });
});

describe('ensureDurableSafeguardingDigestSchedule', () => {
  it('starts the versioned singleton when absent', async () => {
    const scheduleNewOrchestration = vi
      .fn()
      .mockResolvedValue(SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID);
    const client = {
      getOrchestrationState: vi.fn().mockResolvedValue(undefined),
      scheduleNewOrchestration,
    };
    await expect(ensureDurableSafeguardingDigestSchedule(client)).resolves.toBe('created');
    expect(scheduleNewOrchestration).toHaveBeenCalledWith(
      SAFEGUARDING_DIGEST_SCHEDULE_ORCHESTRATOR,
      {},
      {
        instanceId: SAFEGUARDING_DIGEST_SCHEDULE_INSTANCE_ID,
        version: SAFEGUARDING_DIGEST_ORCHESTRATION_VERSION,
      },
    );
  });

  it('reconciles a concurrent start and refuses terminal history', async () => {
    const raced = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ runtimeStatus: OrchestrationStatus.RUNNING }),
      scheduleNewOrchestration: vi.fn().mockRejectedValue(new Error('already exists')),
    };
    await expect(ensureDurableSafeguardingDigestSchedule(raced)).resolves.toBe('existing');

    const terminal = {
      getOrchestrationState: vi
        .fn()
        .mockResolvedValue({ runtimeStatus: OrchestrationStatus.FAILED }),
      scheduleNewOrchestration: vi.fn(),
    };
    await expect(ensureDurableSafeguardingDigestSchedule(terminal)).rejects.toThrow(
      /Deploy a new versioned singleton ID/,
    );
  });
});
