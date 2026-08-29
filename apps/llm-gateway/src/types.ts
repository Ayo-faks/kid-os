export type GatewayProvider = 'azure-openai' | 'foundry' | 'ollama';

export type GatewayTask =
  | 'chat.general'
  | 'draft-email'
  | 'draft.high-stakes'
  | 'embed'
  | 'extract-structured'
  | 'narrate-rota'
  | 'summarize';

export interface GatewayConfig {
  readonly azureAiInferenceEndpoint: string;
  readonly azureAiInferenceKey: string;
  readonly azureOpenAiApiKey: string;
  readonly azureOpenAiApiVersion: string;
  readonly azureOpenAiEndpoint: string;
  readonly defaultModel: string;
  readonly monthlyTokenBudget: number;
  readonly ollamaUrl: string;
  readonly port: number;
  readonly provider: GatewayProvider;
  readonly redisUrl: string;
  readonly serviceToken: string;
}

export interface BudgetStore {
  addUsage(tenantId: string, bucket: string, tokens: number): Promise<number>;
  close(): Promise<void>;
  getUsage(tenantId: string, bucket: string): Promise<number>;
}
