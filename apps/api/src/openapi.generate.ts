import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

import { AppModule } from './app.module.js';
import { writeOpenApiDocument } from './swagger/openapi.js';

async function generate(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { logger: false },
  );

  await writeOpenApiDocument(app);
  await app.close();
  process.exitCode = 0;
}

void generate().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
