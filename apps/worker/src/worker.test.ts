import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APPROVALS_TASK_QUEUE,
  DEFAULT_DOCUMENTS_TASK_QUEUE,
  DEFAULT_EMAIL_DRAFTS_TASK_QUEUE,
  DEFAULT_EXPORT_BUNDLES_TASK_QUEUE,
  DEFAULT_HANDOVERS_TASK_QUEUE,
  DEFAULT_INCIDENTS_TASK_QUEUE,
  DEFAULT_NOTIFICATIONS_TASK_QUEUE,
  DEFAULT_RETENTION_TASK_QUEUE,
  DEFAULT_ROTA_TASK_QUEUE,
  DEFAULT_TASK_QUEUE,
  DEFAULT_TEMPORAL_ADDRESS,
  DEFAULT_TEMPORAL_NAMESPACE,
  getWorkerRuntimeConfig,
  getWorkflowBundlePath,
  getWorkflowEntryPath,
} from './worker.js';

describe('worker runtime config', () => {
  it('uses Phase 0 defaults', () => {
    expect(getWorkerRuntimeConfig({}, 'file:///repo/apps/worker/dist/worker.js')).toEqual({
      approvalsTaskQueue: DEFAULT_APPROVALS_TASK_QUEUE,
      documentsTaskQueue: DEFAULT_DOCUMENTS_TASK_QUEUE,
      emailDraftsTaskQueue: DEFAULT_EMAIL_DRAFTS_TASK_QUEUE,
      exportBundlesTaskQueue: DEFAULT_EXPORT_BUNDLES_TASK_QUEUE,
      handoversTaskQueue: DEFAULT_HANDOVERS_TASK_QUEUE,
      incidentsTaskQueue: DEFAULT_INCIDENTS_TASK_QUEUE,
      namespace: DEFAULT_TEMPORAL_NAMESPACE,
      notificationsTaskQueue: DEFAULT_NOTIFICATIONS_TASK_QUEUE,
      retentionTaskQueue: DEFAULT_RETENTION_TASK_QUEUE,
      rotaTaskQueue: DEFAULT_ROTA_TASK_QUEUE,
      taskQueue: DEFAULT_TASK_QUEUE,
      temporalAddress: DEFAULT_TEMPORAL_ADDRESS,
      workflowBundlePath: '/repo/apps/worker/dist/workflow-bundle.js',
      workflowsPath: '/repo/apps/worker/dist/workflows/index.js',
    });
  });

  it('reads Temporal connection settings from the environment', () => {
    expect(
      getWorkerRuntimeConfig(
        {
          TEMPORAL_HOST: 'localhost:7233',
          TEMPORAL_EMAIL_DRAFTS_TASK_QUEUE: 'careos.emails.dev',
          TEMPORAL_APPROVALS_TASK_QUEUE: 'careos.approvals.dev',
          TEMPORAL_DOCUMENTS_TASK_QUEUE: 'careos.documents.dev',
          TEMPORAL_EXPORT_BUNDLES_TASK_QUEUE: 'careos.export-bundles.dev',
          TEMPORAL_HANDOVERS_TASK_QUEUE: 'careos.handovers.dev',
          TEMPORAL_INCIDENTS_TASK_QUEUE: 'careos.incidents.dev',
          TEMPORAL_NAMESPACE: 'careos-dev',
          TEMPORAL_NOTIFICATIONS_TASK_QUEUE: 'careos.notifications.dev',
          TEMPORAL_RETENTION_TASK_QUEUE: 'careos.retention.dev',
          TEMPORAL_ROTA_TASK_QUEUE: 'careos.rota.dev',
          TEMPORAL_TASK_QUEUE: 'careos.custom',
        },
        'file:///repo/apps/worker/src/worker.ts',
      ),
    ).toEqual({
      approvalsTaskQueue: 'careos.approvals.dev',
      documentsTaskQueue: 'careos.documents.dev',
      emailDraftsTaskQueue: 'careos.emails.dev',
      exportBundlesTaskQueue: 'careos.export-bundles.dev',
      handoversTaskQueue: 'careos.handovers.dev',
      incidentsTaskQueue: 'careos.incidents.dev',
      namespace: 'careos-dev',
      notificationsTaskQueue: 'careos.notifications.dev',
      retentionTaskQueue: 'careos.retention.dev',
      rotaTaskQueue: 'careos.rota.dev',
      taskQueue: 'careos.custom',
      temporalAddress: 'localhost:7233',
      workflowBundlePath: null,
      workflowsPath: '/repo/apps/worker/src/workflows/index.ts',
    });
  });

  it('selects the workflow entry extension from the current entrypoint', () => {
    expect(getWorkflowEntryPath('file:///repo/apps/worker/src/worker.ts')).toBe(
      '/repo/apps/worker/src/workflows/index.ts',
    );
    expect(getWorkflowEntryPath('file:///repo/apps/worker/dist/worker.js')).toBe(
      '/repo/apps/worker/dist/workflows/index.js',
    );
    expect(getWorkflowBundlePath('file:///repo/apps/worker/src/worker.ts')).toBeNull();
    expect(getWorkflowBundlePath('file:///repo/apps/worker/dist/worker.js')).toBe(
      '/repo/apps/worker/dist/workflow-bundle.js',
    );
  });
});
