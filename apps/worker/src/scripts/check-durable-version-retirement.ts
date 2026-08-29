import { createAzureManagedClient } from '@microsoft/durabletask-js-azuremanaged';

import { inspectDurableVersionRetirement } from '../durable/version-retirement.js';

const version = process.argv[2]?.trim();
if (version === undefined || version === '') {
  throw new Error('Usage: pnpm check-durable-version-retirement <version>');
}

const connectionString = process.env.DURABLE_TASK_SCHEDULER_CONNECTION_STRING?.trim();
if (connectionString === undefined || connectionString === '') {
  throw new Error('DURABLE_TASK_SCHEDULER_CONNECTION_STRING is required.');
}

const client = createAzureManagedClient(connectionString);
try {
  const report = await inspectDurableVersionRetirement(client, version);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.canRetire) process.exitCode = 3;
} finally {
  await client.stop();
}
