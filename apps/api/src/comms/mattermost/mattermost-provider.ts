// Phase 3 §1 — Mattermost provider abstraction.
//
// The provider posts messages to Mattermost channels and DMs. The default
// implementation is a disabled stub that records intent without making any
// HTTP call; this is what runs unless `MATTERMOST_BOT_TOKEN` and
// `MATTERMOST_URL` are configured. The HTTP-backed implementation is the
// minimal surface needed to satisfy automation outbox dispatch from the
// worker — actual posting is gated on those env vars being present.

export interface MattermostPostInput {
  readonly channelId: string;
  readonly message: string;
  readonly correlationId: string;
}

export interface MattermostDirectMessageInput {
  readonly mattermostUserId: string;
  readonly message: string;
  readonly correlationId: string;
}

export interface MattermostPostResult {
  readonly delivered: boolean;
  readonly providerMessageId: string | null;
  readonly reason?: string;
}

export interface MattermostProvider {
  readonly kind: 'disabled' | 'http';
  postToChannel(input: MattermostPostInput): Promise<MattermostPostResult>;
  postDirectMessage(input: MattermostDirectMessageInput): Promise<MattermostPostResult>;
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

  postDirectMessage(_input: MattermostDirectMessageInput): Promise<MattermostPostResult> {
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
    return this.post('/api/v4/posts', {
      channel_id: input.channelId,
      message: input.message,
      props: { careos_correlation_id: input.correlationId },
    });
  }

  postDirectMessage(input: MattermostDirectMessageInput): Promise<MattermostPostResult> {
    // The HTTP path needs a DM channel resolved before posting; the worker
    // performs that lookup before calling. For the foundation slice we leave
    // resolution to the caller and surface unsupported direct-mode here.
    return Promise.resolve({
      delivered: false,
      providerMessageId: null,
      reason: `http-dm-unsupported: ${input.mattermostUserId}`,
    });
  }

  private async post(path: string, body: unknown): Promise<MattermostPostResult> {
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      body: JSON.stringify(body),
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
