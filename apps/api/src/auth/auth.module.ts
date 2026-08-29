import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { KeycloakJwtGuard } from './keycloak-jwt.guard.js';

@Module({
  providers: [
    KeycloakJwtGuard,
    {
      provide: APP_GUARD,
      useExisting: KeycloakJwtGuard,
    },
  ],
  exports: [KeycloakJwtGuard],
})
export class AuthModule {}
