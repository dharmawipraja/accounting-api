import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from '../app.module';
import { ErrorEnvelopeDto } from '../common/openapi/openapi.models';

async function main(): Promise<void> {
  // preview mode builds the metadata graph WITHOUT instantiating providers,
  // so no DB connection / onModuleInit runs — generation needs only route/DTO metadata.
  const app = await NestFactory.create(AppModule, {
    preview: true,
    logger: false,
  });
  // Must match main.ts — URI versioning puts business routes under /v1;
  // version-neutral probes (/health, /ready, /metrics) stay unprefixed.
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  const config = new DocumentBuilder()
    .setTitle('Indonesian Accounting API')
    .setDescription(
      'Conventions, roles, and lifecycles: see docs/api/frontend-guide.md',
    )
    .setVersion('1.1.0')
    .addBearerAuth()
    .addTag('Auth')
    .build();
  const document = SwaggerModule.createDocument(app, config, {
    extraModels: [ErrorEnvelopeDto],
  });
  const outDir = join(process.cwd(), 'docs', 'api');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'openapi.json'),
    JSON.stringify(document, null, 2),
  );
  await app.close();
  console.log('Wrote docs/api/openapi.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
