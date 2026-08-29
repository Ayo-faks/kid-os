import { Module } from '@nestjs/common';

import { McpController } from './mcp.controller.js';

@Module({
  controllers: [McpController],
})
export class McpModule {}
