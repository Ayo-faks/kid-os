import './instrumentation.js';

import { RedisBudgetStore } from './budget-store.js';
import { loadGatewayConfig } from './config.js';
import { buildGateway } from './server.js';

const config = loadGatewayConfig();
const gateway = buildGateway({
  budgetStore: new RedisBudgetStore(config.redisUrl),
  config,
});

await gateway.listen({ host: '0.0.0.0', port: config.port });
process.stdout.write(
  `[llm-gateway] listening on 0.0.0.0:${config.port} provider=${config.provider} model=${config.defaultModel}\n`,
);
