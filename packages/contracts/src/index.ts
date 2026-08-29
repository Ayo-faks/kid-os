// Phase 1 will populate this with shared Zod schemas and an OpenAPI-generated
// client. For Phase 0 we export only a version marker so dependents can compile.
export const CONTRACTS_VERSION = '0.0.0' as const;

export * from './incidents-workflow.js';
export * from './incidents-activities.js';
export * from './handovers-workflow.js';
export * from './handovers-activities.js';
export * from './email-drafts-workflow.js';
export * from './email-drafts-activities.js';
export * from './approvals-workflow.js';
export * from './approvals-activities.js';
export * from './rota-workflow.js';
export * from './rota-activities.js';
export * from './approval-policy.js';
export * from './post-approval-actions.js';
export * from './ping-workflow.js';
export * from './incident-follow-ups-workflow.js';
export * from './incident-follow-ups-activities.js';
export * from './mattermost-activities.js';
export * from './shift-reminder-activities.js';
export * from './handover-due-reminder-activities.js';
export * from './missing-fields-audit-activities.js';
export * from './safeguarding-digest-activities.js';
export * from './documents-activities.js';
export * from './reports.js';
export * from './export-bundles-activities.js';
export * from './retention-activities.js';
