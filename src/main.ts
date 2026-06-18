import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import type { Env } from './infrastructure/config/env.schema';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Reject unknown/extra fields at the edge — defense against mass assignment.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors();

  // OpenAPI is our contract source of truth (ADR-0004): the Next.js front
  // generates its typed client from this spec, so back and front never drift.
  const openApiConfig = new DocumentBuilder()
    .setTitle('Helpdesk API')
    .setDescription('Multi-tenant, event-driven helpdesk — OpenAPI contract')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('docs', app, document);

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
