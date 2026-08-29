import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// POST /comms/mattermost/link-codes — issued by a logged-in CareOS user.
export const IssueLinkCodeSchema = z
  .object({
    // Mattermost username hint shown to the user when they paste the code.
    mattermostHint: z.string().min(1).max(120).optional(),
  })
  .strict();

export class IssueLinkCodeDto extends createZodDto(IssueLinkCodeSchema) {}

export interface IssueLinkCodeResponse {
  readonly code: string;
  readonly expiresAt: string;
  readonly slashCommand: string;
}

// POST /comms/mattermost/link-codes/exchange — called by the Mattermost bot.
// Tenant + home come from the channel mapping the bot already knows.
const uuid = z.string().uuid();

export const ExchangeLinkCodeSchema = z
  .object({
    code: z.string().min(8).max(64),
    tenantId: uuid,
    homeId: uuid,
    mattermostUserId: z.string().min(1).max(64),
    mattermostUsername: z.string().min(1).max(120),
  })
  .strict();

export class ExchangeLinkCodeDto extends createZodDto(ExchangeLinkCodeSchema) {}

export interface ExchangeLinkCodeResponse {
  readonly linked: true;
  readonly userId: string;
  readonly displayName: string;
}

// Channel mappings — managers wire (tenant, home, kind) -> mattermost channel.
const ChannelKindSchema = z.enum(['home', 'safeguarding', 'rota', 'general']);

export const UpsertChannelMappingSchema = z
  .object({
    kind: ChannelKindSchema,
    channelId: z.string().min(1).max(64),
    channelName: z.string().min(1).max(120),
  })
  .strict();

export class UpsertChannelMappingDto extends createZodDto(UpsertChannelMappingSchema) {}

export interface ChannelMappingResponse {
  readonly id: string;
  readonly kind: 'home' | 'safeguarding' | 'rota' | 'general';
  readonly channelId: string;
  readonly channelName: string;
  readonly updatedAt: string;
}

export interface ListChannelMappingsResponse {
  readonly mappings: readonly ChannelMappingResponse[];
}
