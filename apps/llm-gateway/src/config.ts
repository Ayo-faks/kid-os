import type { GatewayConfig, GatewayProvider } from './types.js';

export function loadGatewayConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): GatewayConfig {
  return {
    azureAiInferenceEndpoint:
      env.AZURE_AI_INFERENCE_ENDPOINT ?? 'https://example.services.ai.azure.com',
    azureAiInferenceKey: env.AZURE_AI_INFERENCE_KEY ?? 'change-me',
    azureOpenAiApiKey: env.AZURE_OPENAI_API_KEY ?? 'change-me',
    azureOpenAiApiVersion: env.AZURE_OPENAI_API_VERSION ?? '2025-01-01-preview',
    azureOpenAiEndpoint: env.AZURE_OPENAI_ENDPOINT ?? 'https://example.openai.azure.com',
    defaultModel: env.CAREOS_LLM_MODEL ?? 'qwen2.5:0.5b-instruct',
    monthlyTokenBudget: positiveInteger(env.LLM_GATEWAY_MONTHLY_TOKEN_BUDGET, 1_000_000),
    ollamaUrl: env.OLLAMA_URL ?? 'http://ollama:11434',
    port: positiveInteger(env.LLM_GATEWAY_PORT, 8080),
    provider: readProvider(env.CAREOS_LLM_PROVIDER),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379/0',
    serviceToken: env.LLM_GATEWAY_SERVICE_TOKEN ?? 'change-me',
  };
}

function readProvider(value: string | undefined): GatewayProvider {
  if (value === undefined || value === 'ollama') return 'ollama';
  if (value === 'azure-openai' || value === 'foundry') return value;
  throw new Error(`Unsupported CAREOS_LLM_PROVIDER: ${value}`);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}
