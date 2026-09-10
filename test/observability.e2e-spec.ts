import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { REQUEST_ID_HEADER } from '../src/infrastructure/observability/request-context';

process.env.THROTTLE_SKIP = '1';

const PASSWORD = 'un-password-seguro';

/**
 * Observabilidad de punta a punta (ADR-0024).
 *
 * Lo que se comprueba no es que "haya logs" —eso sería testear a pino— sino los
 * dos contratos que el resto del sistema y los operadores dan por buenos: que
 * toda respuesta lleva su identificador de correlación, y que ese identificador
 * viaja con el evento hasta el worker que lo consume.
 */
describe('Observabilidad (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  const slug = `obs-${run}`;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: slug,
        email: `ana@${slug}.test`,
        password: PASSWORD,
      })
      .expect(201);

    token = (res.body as { accessToken: string }).accessToken;
    tenantId = (
      JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      ) as { tenantId: string }
    ).tenantId;
  });

  afterAll(async () => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
  });

  describe('correlación', () => {
    it('toda respuesta trae su identificador', async () => {
      // Sin devolverlo, correlacionar el problema que reporta un usuario con sus
      // logs depende de adivinar la hora exacta.
      const res = await request(app.getHttpServer()).get('/health').expect(200);

      expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[\w.:-]+$/);
    });

    it('respeta el identificador entrante para no romper la cadena', async () => {
      const res = await request(app.getHttpServer())
        .get('/health')
        .set(REQUEST_ID_HEADER, 'traza-de-otro-servicio')
        .expect(200);

      expect(res.headers[REQUEST_ID_HEADER]).toBe('traza-de-otro-servicio');
    });

    it('descarta un identificador entrante peligroso y genera uno propio', async () => {
      // Se prueba con llaves y comillas: son válidas en una cabecera HTTP pero
      // quedan fuera de lo que se acepta. Las de verdad peligrosas, como un
      // salto de línea, ni siquiera pasan el cliente HTTP porque son inválidas
      // en el protocolo; lo que llega de verdad al saneador es esto.
      const res = await request(app.getHttpServer())
        .get('/health')
        .set(REQUEST_ID_HEADER, '{"inyectado":true}')
        .expect(200);

      expect(res.headers[REQUEST_ID_HEADER]).not.toContain('inyectado');
      expect(res.headers[REQUEST_ID_HEADER]).toMatch(/^[\w.:-]+$/);
    });

    it('el evento guarda la petición que lo originó', async () => {
      // El corazón del ADR-0024: el outbox conserva el `request_id` para que el
      // worker que consuma el evento —en otro proceso y más tarde— pueda seguir
      // escribiendo bajo la misma historia.
      const traza = `e2e-${randomUUID()}`;

      const creado = await request(app.getHttpServer())
        .post('/tickets')
        .set('Authorization', `Bearer ${token}`)
        .set(REQUEST_ID_HEADER, traza)
        .send({ subject: 'Con traza', description: 'Correlación.' })
        .expect(201);

      const ticketId = (creado.body as { id: string }).id;

      const mensajes = await prisma.withTenant(tenantId, (tx) =>
        tx.outboxMessage.findMany({
          where: { tenantId, aggregateId: ticketId },
        }),
      );

      expect(mensajes.length).toBeGreaterThan(0);
      expect(mensajes.every((m) => m.requestId === traza)).toBe(true);
    });
  });

  describe('sondas de salud', () => {
    it('liveness no toca dependencias', async () => {
      const res = await request(app.getHttpServer())
        .get('/health/live')
        .expect(200);

      expect(res.body).toMatchObject({ status: 'ok' });
    });

    it('readiness comprueba Postgres y Redis', async () => {
      // Es la diferencia que importa para un orquestador: si esto fallara
      // reiniciando el proceso —lo que haría liveness— no arreglaría una base de
      // datos caída, solo tiraría las conexiones que quedaban.
      const res = await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200);

      expect(res.body).toMatchObject({
        status: 'ok',
        info: {
          postgres: { status: 'up' },
          redis: { status: 'up' },
        },
      });
    });

    it('el alias histórico de la fase 1 sigue respondiendo', async () => {
      // Hay contenedores apuntando a `/health` desde antes de que existieran
      // `/live` y `/ready`; cambiarlo por debajo sería romperlos en silencio.
      await request(app.getHttpServer()).get('/health').expect(200);
    });
  });
});
