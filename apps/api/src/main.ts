import './instrumentation.js';
import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module.js';
import { configureApp } from './setup.js';
import { writeOpenApiDocument } from './swagger/openapi.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { bufferLogs: true },
  );

  configureApp(app);
  app.useLogger(app.get(Logger));

  if (process.env.GENERATE_OPENAPI !== 'false') {
    await writeOpenApiDocument(app);
  }

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

void bootstrap();
