import { Module } from '@nestjs/common';

import { AssistantController } from './assistant.controller.js';
import { AssistantService } from './assistant.service.js';
import { HermesAssistantProvider } from './hermes-assistant.provider.js';
import { ASSISTANT_STREAM_PROVIDER } from './stream-provider.js';

@Module({
  controllers: [AssistantController],
  providers: [
    AssistantService,
    HermesAssistantProvider,
    {
      provide: ASSISTANT_STREAM_PROVIDER,
      useExisting: HermesAssistantProvider,
    },
  ],
  exports: [AssistantService],
})
export class AssistantModule {}
