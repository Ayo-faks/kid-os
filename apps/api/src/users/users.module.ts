import { Module } from '@nestjs/common';

import { UsersService } from './users.service.js';

@Module({
  exports: [UsersService],
  providers: [UsersService],
})
export class UsersModule {}
