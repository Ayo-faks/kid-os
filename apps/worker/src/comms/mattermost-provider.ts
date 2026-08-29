// Phase 3 §1 (D1 wiring) — worker-side Mattermost provider.
//
// Mirror of `apps/api/src/comms/mattermost/mattermost-provider.ts`. We
// duplicate rather than cross-import so the worker stays decoupled from
// NestJS DI. The HTTP implementation activates only when both
// MATTERMOST_URL and MATTERMOST_BOT_TOKEN are set to non-default values.

export interface MattermostPostInput {
  readonly channelId: string;
  readonly message: string;
  readonly correlationId: string;
  readonly pendingPostId?: string;
}

export interface MattermostPostResult {
  readonly delivered: boolean;
  readonly providerMessageId: string | null;
  readonly reason?: string;
}

export interface MattermostProvider {
  readonly kind: 'disabled' | 'http';
  postToChannel(input: MattermostPostInput): Promise<MattermostPostResult>;
}

export class DisabledMattermostProvider implements MattermostProvider {
  readonly kind = 'disabled' as const;

  postToChannel(_input: MattermostPostInput): Promise<MattermostPostResult> {
    return Promise.resolve({
      delivered: false,
      providerMessageId: null,
      reason: 'mattermost-disabled',
    });
  }
}

export interface MattermostHttpConfig {
  readonly baseUrl: string;
  readonly botToken: string;
}

export class HttpMattermostProvider implements MattermostProvider {
  readonly kind = 'http' as const;

  constructor(private readonly config: MattermostHttpConfig) {}

  async postToChannel(input: MattermostPostInput): Promise<MattermostPostResult> {
    const response = await fetch(`${this.config.baseUrl}/api/v4/posts`, {
      body: JSON.stringify({
        channel_id: input.channelId,
        message: input.message,
        ...(input.pendingPostId === undefined ? {} : { pending_post_id: input.pendingPostId }),
        props: { careos_correlation_id: input.correlationId },
      }),
      headers: {
        authorization: `Bearer ${this.config.botToken}`,
        'content-type': 'application/json',
      },
      method: 'POST',
    });

    if (!response.ok) {
      return {
        delivered: false,
        providerMessageId: null,
        reason: `http-${response.status}`,
      };
    }

    const payload = (await response.json()) as { readonly id?: string };
    return { delivered: true, providerMessageId: payload.id ?? null };
  }
}

export function buildMattermostProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): MattermostProvider {
  const baseUrl = env.MATTERMOST_URL?.trim();
  const botToken = env.MATTERMOST_BOT_TOKEN?.trim();
  if (
    baseUrl !== undefined &&
    baseUrl !== '' &&
    botToken !== undefined &&
    botToken !== '' &&
    botToken !== 'change-me'
  ) {
    return new HttpMattermostProvider({ baseUrl, botToken });
  }
  return new DisabledMattermostProvider();
}
