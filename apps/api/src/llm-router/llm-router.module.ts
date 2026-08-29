import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';

import { LlmRouterService } from './llm-router.service.js';

@Module({
  imports: [HttpModule],
  providers: [LlmRouterService],
  exports: [LlmRouterService],
})
export class LlmRouterModule {}
