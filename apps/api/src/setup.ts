import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { ZodValidationPipe } from 'nestjs-zod';

import { setupSwagger } from './swagger/openapi.js';

export function configureApp(app: NestFastifyApplication): void {
  app.enableShutdownHooks();
  app.useGlobalPipes(new ZodValidationPipe());

  if (process.env.ENABLE_SWAGGER_UI === 'true') {
    setupSwagger(app);
  }
}
