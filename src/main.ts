import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { attachRealtimeAdapter } from './infrastructure/realtime/redis-io.adapter';
import type { Env } from './infrastructure/config/env.schema';

async function bootstrap(): Promise<void> {
  // `bufferLogs`: retiene los mensajes de arranque hasta que el logger real
  // esté disponible. Sin esto, todo lo que ocurre antes de `useLogger` sale con
  // el logger por defecto de Nest — justo los mensajes que más se miran cuando
  // una instancia no levanta.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Pino SUSTITUYE al logger de Nest, no convive con él: si no, la mitad de lo
  // que pasa en producción quedaría fuera de las consultas por no ser JSON.
  app.useLogger(app.get(Logger));

  configureApp(app);

  // Antes de `listen`: el servidor de Socket.io se crea al arrancar, y si el
  // adapter no está puesto para entonces las rooms quedan locales al proceso.
  await attachRealtimeAdapter(app);

  // OpenAPI is our contract source of truth (ADR-0004): the Next.js front
  // generates its typed client from this spec, so back and front never drift.
  const openApiConfig = new DocumentBuilder()
    .setTitle('Helpdesk API')
    .setDescription('Multi-tenant, event-driven helpdesk — OpenAPI contract')
    .setVersion('1.0')
    .addBearerAuth()
    .addCookieAuth('refresh_token')
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('docs', app, document);

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
