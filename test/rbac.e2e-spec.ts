import { randomUUID } from 'node:crypto';
import { Controller, Get, INestApplication, UseGuards } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { JwtAuthGuard } from '../src/modules/iam/infrastructure/auth/jwt-auth.guard';
import { MinRole } from '../src/modules/iam/infrastructure/auth/min-role.decorator';
import { Role } from '../src/modules/iam/domain/role';

// Esta suite hace un login por cada rol que prueba; el límite tiene su propia
// suite (`auth-rate-limit.e2e-spec.ts`).
process.env.THROTTLE_SKIP = '1';

/**
 * Controller que existe SOLO para este test.
 *
 * Se define acá y no en `src/` a propósito: la fase 3 entrega el mecanismo de
 * autorización, no rutas de producto (eso es la fase 4). Meter endpoints de
 * prueba en el código real para poder testearlos es una deuda que nunca se paga.
 */
@Controller('rbac-test')
class RbacTestController {
  @Get('open')
  open(): { ok: string } {
    return { ok: 'open' }; // sin guard ni @MinRole: debe pasar siempre
  }

  @Get('authenticated')
  @UseGuards(JwtAuthGuard)
  authenticated(): { ok: string } {
    return { ok: 'authenticated' }; // sesión, pero sin requisito de rol
  }

  @Get('viewer')
  @UseGuards(JwtAuthGuard)
  @MinRole('VIEWER')
  viewer(): { ok: string } {
    return { ok: 'viewer' };
  }

  @Get('agent')
  @UseGuards(JwtAuthGuard)
  @MinRole('AGENT')
  agent(): { ok: string } {
    return { ok: 'agent' };
  }

  @Get('admin')
  @UseGuards(JwtAuthGuard)
  @MinRole('ADMIN')
  admin(): { ok: string } {
    return { ok: 'admin' };
  }

  @Get('sin-guard')
  @MinRole('ADMIN')
  sinGuard(): { ok: string } {
    // Error de programación deliberado: @MinRole sin JwtAuthGuard. El guard debe
    // responder 401 (falta sesión) y no dejar pasar por descuido.
    return { ok: 'no debería llegar acá sin sesión' };
  }
}

describe('RBAC (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  const orgSlug = `rbac-${run}`;
  const email = `ana@rbac-${run}.test`;
  const password = 'un-password-seguro';

  let tenantId: string;
  let userId: string;

  /** Cambia el rol del membership en la BD y devuelve un token nuevo. */
  const loginAs = async (role: Role): Promise<string> => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.membership.updateMany({ where: { userId, tenantId }, data: { role } }),
    );

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ organizationSlug: orgSlug, email, password })
      .expect(200);

    return (res.body as { accessToken: string }).accessToken;
  };

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(`/rbac-test/${path}`);
    return token === undefined
      ? req
      : req.set('Authorization', `Bearer ${token}`);
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [RbacTestController],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ organizationName: `RBAC ${run}`, email, password })
      .expect(201);

    const claims = JSON.parse(
      Buffer.from(
        (res.body as { accessToken: string }).accessToken.split('.')[1],
        'base64url',
      ).toString('utf8'),
    ) as { sub: string; tenantId: string };

    userId = claims.sub;
    tenantId = claims.tenantId;
  });

  afterAll(async () => {
    await prisma.withTenant(tenantId, (tx) =>
      tx.organization.deleteMany({ where: { id: tenantId } }),
    );
    await app.close();
  });

  // ------------------------------------------------------ rutas sin requisito

  it('una ruta sin @MinRole pasa aunque no haya sesión', async () => {
    await get('open').expect(200);
  });

  it('el guard global no rompe las rutas que solo exigen sesión', async () => {
    const token = await loginAs('VIEWER');
    await get('authenticated', token).expect(200);
    await get('authenticated').expect(401);
  });

  // --------------------------------------------------------------- jerarquía

  it('ADMIN satisface todos los rangos', async () => {
    const token = await loginAs('ADMIN');
    await get('viewer', token).expect(200);
    await get('agent', token).expect(200);
    await get('admin', token).expect(200);
  });

  it('AGENT satisface hasta AGENT, pero no ADMIN', async () => {
    const token = await loginAs('AGENT');
    await get('viewer', token).expect(200);
    await get('agent', token).expect(200);
    await get('admin', token).expect(403);
  });

  it('VIEWER solo satisface VIEWER', async () => {
    const token = await loginAs('VIEWER');
    await get('viewer', token).expect(200);
    await get('agent', token).expect(403);
    await get('admin', token).expect(403);
  });

  // ------------------------------------------------------------- distinciones

  it('distingue falta de sesión (401) de falta de rango (403)', async () => {
    await get('admin').expect(401);

    const token = await loginAs('VIEWER');
    await get('admin', token).expect(403);
  });

  it('@MinRole sin JwtAuthGuard sigue exigiendo sesión', async () => {
    // El guard global es la red que atrapa el olvido del desarrollador.
    await get('sin-guard').expect(401);
  });

  it('el 403 dice qué rango hacía falta, sin filtrar nada más', async () => {
    const token = await loginAs('VIEWER');
    const res = await get('admin', token).expect(403);

    expect((res.body as { message: string }).message).toContain('ADMIN');
  });

  // ---------------------------------------------------- rol viejo en el token

  it('el rol viaja en el token: degradar en BD no invalida el token ya emitido', async () => {
    const adminToken = await loginAs('ADMIN');
    await get('admin', adminToken).expect(200);

    // Se degrada en base de datos, pero el token de 15 min sigue diciendo ADMIN.
    await prisma.withTenant(tenantId, (tx) =>
      tx.membership.updateMany({
        where: { userId, tenantId },
        data: { role: 'VIEWER' },
      }),
    );

    // Consecuencia conocida y documentada en el ADR-0014: la autorización se
    // resuelve con los claims, sin ir a la base de datos en cada request.
    await get('admin', adminToken).expect(200);

    // Al renovar la sesión sí se re-lee el membership y el rol nuevo aplica.
    const renewed = await loginAs('VIEWER');
    await get('admin', renewed).expect(403);
  });
});
