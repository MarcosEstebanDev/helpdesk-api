import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { Role } from '../src/modules/iam/domain/role';
import { DEFAULT_SLA_POLICY } from '../src/modules/ticketing/domain/sla/sla-policy';

process.env.THROTTLE_SKIP = '1';

interface Organizacion {
  slug: string;
  email: string;
  tenantId: string;
  userId: string;
  token: string;
}

interface TargetVigente {
  priority: string;
  responseMinutes: number;
  resolutionMinutes: number;
  source: string;
}

const PASSWORD = 'un-password-seguro';

describe('Política de SLA (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
  /** Segunda organización: la política de una no puede alcanzar a la otra. */
  let otra: Organizacion;

  const claimsDe = (accessToken: string): { sub: string; tenantId: string } =>
    JSON.parse(
      Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'),
    ) as { sub: string; tenantId: string };

  const registrar = async (nombre: string): Promise<Organizacion> => {
    const email = `ana@${nombre}.test`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: nombre, email, password: PASSWORD })
      .expect(201);

    const token = (res.body as { accessToken: string }).accessToken;
    const claims = claimsDe(token);
    return {
      slug: nombre,
      email,
      tenantId: claims.tenantId,
      userId: claims.sub,
      token,
    };
  };

  const tokenConRol = async (
    org: Organizacion,
    role: Role,
  ): Promise<string> => {
    await prisma.withTenant(org.tenantId, (tx) =>
      tx.membership.updateMany({
        where: { userId: org.userId, tenantId: org.tenantId },
        data: { role },
      }),
    );

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({
        organizationSlug: org.slug,
        email: org.email,
        password: PASSWORD,
      })
      .expect(200);

    return (res.body as { accessToken: string }).accessToken;
  };

  // Sin `async`: devuelve el encadenable de supertest.
  const conAuth = (
    metodo: 'get' | 'put' | 'delete',
    ruta: string,
    token: string,
  ) =>
    request(app.getHttpServer())
      [metodo](ruta)
      .set('Authorization', `Bearer ${token}`);

  const urgenteDe = (body: unknown): TargetVigente | undefined =>
    (body as TargetVigente[]).find((t) => t.priority === 'URGENT');

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`acme-sla-${run}`);
    otra = await registrar(`otra-sla-${run}`);
  });

  afterAll(async () => {
    for (const org of [acme, otra]) {
      await prisma.withTenant(org.tenantId, (tx) =>
        tx.organization.deleteMany({ where: { id: org.tenantId } }),
      );
    }
    await app.close();
  });

  describe('lectura', () => {
    it('una organización recién creada ya tiene las cuatro prioridades', async () => {
      // No hay ninguna fila en `sla_policies`: la respuesta sale del dominio.
      const res = await conAuth('get', '/sla-policy', acme.token).expect(200);

      expect(res.body).toHaveLength(4);
      expect(urgenteDe(res.body)).toEqual({
        priority: 'URGENT',
        ...DEFAULT_SLA_POLICY.URGENT,
        source: 'default',
      });
    });
  });

  describe('configuración', () => {
    it('fija el objetivo de una prioridad y lo marca como pactado', async () => {
      const res = await conAuth('put', '/sla-policy/URGENT', acme.token)
        .send({ responseMinutes: 5, resolutionMinutes: 30 })
        .expect(200);

      expect(urgenteDe(res.body)).toEqual({
        priority: 'URGENT',
        responseMinutes: 5,
        resolutionMinutes: 30,
        source: 'organization',
      });

      // Y persiste: la siguiente lectura no depende de la respuesta anterior.
      const leido = await conAuth('get', '/sla-policy', acme.token).expect(200);
      expect(urgenteDe(leido.body)?.responseMinutes).toBe(5);
    });

    it('deja rastro de auditoría del cambio', async () => {
      const entradas = await prisma.withTenant(acme.tenantId, (tx) =>
        tx.auditLog.findMany({
          where: { tenantId: acme.tenantId, action: 'sla.policy_changed' },
        }),
      );

      expect(entradas.length).toBeGreaterThan(0);
      expect(entradas[0].entityId).toBe(acme.tenantId);
      // La prioridad tocada viaja en `metadata`: `entity_id` es una columna UUID
      // en todo el sistema y la entidad auditada es la política del tenant.
      expect(entradas[0].metadata).toMatchObject({ priority: 'URGENT' });
    });

    it('la política de una organización no alcanza a la otra', async () => {
      // El aislamiento no es cosa del caso de uso: lo impone RLS. `otra` no ha
      // configurado nada y sigue con los valores de fábrica.
      const res = await conAuth('get', '/sla-policy', otra.token).expect(200);

      expect(urgenteDe(res.body)).toEqual({
        priority: 'URGENT',
        ...DEFAULT_SLA_POLICY.URGENT,
        source: 'default',
      });
    });

    it('vuelve al valor por defecto al resetear', async () => {
      const res = await conAuth(
        'delete',
        '/sla-policy/URGENT',
        acme.token,
      ).expect(200);

      expect(urgenteDe(res.body)).toEqual({
        priority: 'URGENT',
        ...DEFAULT_SLA_POLICY.URGENT,
        source: 'default',
      });
    });
  });

  describe('validación', () => {
    it('rechaza prometer resolver antes que responder', async () => {
      // La regla vive en el dominio, no en el DTO: los dos números son válidos
      // por separado y `class-validator` los dejaría pasar.
      const res = await conAuth('put', '/sla-policy/HIGH', acme.token)
        .send({ responseMinutes: 240, resolutionMinutes: 30 })
        .expect(400);

      expect((res.body as { code: string }).code).toBe(
        'ticketing.invalid_sla_target',
      );
    });

    it('rechaza plazos que no son minutos enteros positivos', async () => {
      await conAuth('put', '/sla-policy/HIGH', acme.token)
        .send({ responseMinutes: 0, resolutionMinutes: 30 })
        .expect(400);

      await conAuth('put', '/sla-policy/HIGH', acme.token)
        .send({ responseMinutes: 1.5, resolutionMinutes: 30 })
        .expect(400);
    });

    it('rechaza una prioridad que no existe', async () => {
      await conAuth('put', '/sla-policy/CRITICAL', acme.token)
        .send({ responseMinutes: 5, resolutionMinutes: 30 })
        .expect(400);
    });
  });

  describe('permisos (ADR-0014)', () => {
    it('un AGENT no puede ni leer la política', async () => {
      // La excepción a la regla del módulo, donde leer es de VIEWER: esto no es
      // un ticket, es lo que la organización se ha comprometido a cumplir.
      const agente = await tokenConRol(otra, 'AGENT');

      await conAuth('get', '/sla-policy', agente).expect(403);
      await conAuth('put', '/sla-policy/URGENT', agente)
        .send({ responseMinutes: 5, resolutionMinutes: 30 })
        .expect(403);
      await conAuth('delete', '/sla-policy/URGENT', agente).expect(403);
    });

    it('sin token no se llega', async () => {
      await request(app.getHttpServer()).get('/sla-policy').expect(401);
    });
  });
});
