import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { stringify } from 'yaml';

const openApiPath =
  process.env.OPENAPI_OUTPUT_PATH ??
  resolve(process.cwd(), '../../packages/contracts/openapi.yaml');

export function createOpenApiDocument(app: NestFastifyApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('CareOS API')
    .setDescription('Phase 0 CareOS API skeleton.')
    .setVersion('0.0.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' })
    .build();

  const document = SwaggerModule.createDocument(app, config);
  document.openapi = '3.1.0';

  return document;
}

export function setupSwagger(app: NestFastifyApplication): void {
  SwaggerModule.setup('/openapi', app, createOpenApiDocument(app), {
    jsonDocumentUrl: '/openapi.json',
    yamlDocumentUrl: '/openapi.yaml',
  });
}

export async function writeOpenApiDocument(app: NestFastifyApplication): Promise<void> {
  await mkdir(dirname(openApiPath), { recursive: true });
  await writeFile(openApiPath, stringify(createOpenApiDocument(app)), 'utf8');
}
