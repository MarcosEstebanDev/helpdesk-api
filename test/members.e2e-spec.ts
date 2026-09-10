import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { Role } from '../src/modules/iam/domain/role';

// Esta suite hace varios logins para cambiar de rol; el rate limiting tiene su
// propia suite (`auth-rate-limit.e2e-spec.ts`).
process.env.THROTTLE_SKIP = '1';

interface Organizacion {
  slug: string;
  email: string;
  tenantId: string;
  userId: string;
  token: string;
}

interface MiembroDto {
  userId: string;
  email: string;
  role: Role;
  joinedAt: string;
}

const PASSWORD = 'un-password-seguro';

/**
 * Directorio de miembros (ADR-0025).
 *
 * Hay dos organizaciones y las DOS están pobladas a propósito: una comprobación
 * de aislamiento contra un tenant vacío no prueba nada, porque no hay nada que
 * pudiera filtrarse.
 */
describe('Members (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const run = randomUUID().slice(0, 8);
  let acme: Organizacion;
  let otra: Organizacion;
  /** Segundo miembro de `acme`, con rol VIEWER. */
  let viewerId: string;
  let viewerEmail: string;

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

  const listar = (token: string) =>
    request(app.getHttpServer())
      .get('/members')
      .set('Authorization', `Bearer ${token}`);

  const miembrosDe = async (token: string): Promise<MiembroDto[]> => {
    const res = await listar(token).expect(200);
    return (res.body as { items: MiembroDto[] }).items;
  };

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);

    acme = await registrar(`acme-${run}`);
    otra = await registrar(`otra-${run}`);

    // Un VIEWER en `acme`. Se inserta directo porque todavía no hay endpoint de
    // invitación: el directorio se puede LEER, no cambiar.
    viewerId = randomUUID();
    viewerEmail = `zoe@acme-${run}.test`;
    await prisma.withTenant(acme.tenantId, async (tx) => {
      await tx.user.create({
        data: {
          id: viewerId,
          tenantId: acme.tenantId,
          email: viewerEmail,
          passwordHash: 'no-se-usa-en-este-test',
        },
      });
      await tx.membership.create({
        data: {
          id: randomUUID(),
          tenantId: acme.tenantId,
          userId: viewerId,
          role: 'VIEWER',
        },
      });
    });
  });

  afterAll(async () => {
    await prisma.organization.deleteMany({
      where: { id: { in: [acme.tenantId, otra.tenantId] } },
    });
    await app.close();
  });

  // ------------------------------------------------------------------ lectura

  it('un AGENT recibe todos los miembros de su organización', async () => {
    const token = await tokenConRol(acme, 'AGENT');
    const miembros = await miembrosDe(token);

    expect(miembros.map((m) => m.userId).sort()).toEqual(
      [acme.userId, viewerId].sort(),
    );
  });

  it('cada miembro trae exactamente userId, email, role y joinedAt', async () => {
    const token = await tokenConRol(acme, 'AGENT');
    const [miembro] = await miembrosDe(token);

    // Juego de claves EXACTO: `users` guarda el hash de la contraseña en la
    // misma tabla que el email, así que lo que no está listado no puede salir.
    expect(Object.keys(miembro).sort()).toEqual([
      'email',
      'joinedAt',
      'role',
      'userId',
    ]);
  });

  it('el listado viene ordenado por email', async () => {
    const token = await tokenConRol(acme, 'AGENT');
    const emails = (await miembrosDe(token)).map((m) => m.email);

    expect(emails).toEqual([...emails].sort());
  });

  it('un ADMIN también puede listar: el requisito es "al menos AGENT"', async () => {
    const token = await tokenConRol(acme, 'ADMIN');
    await listar(token).expect(200);
  });

  // El rango restringe a quien LLAMA, no lo que se devuelve. Explícito para que
  // nadie lo "arregle" filtrando a los VIEWER de la respuesta.
  it('el listado incluye a los VIEWER de la organización', async () => {
    const token = await tokenConRol(acme, 'AGENT');
    const miembros = await miembrosDe(token);

    expect(miembros.some((m) => m.role === 'VIEWER')).toBe(true);
  });

  it('un usuario sin membership no aparece', async () => {
    const sueltoId = randomUUID();
    await prisma.withTenant(acme.tenantId, (tx) =>
      tx.user.create({
        data: {
          id: sueltoId,
          tenantId: acme.tenantId,
          email: `suelto-${run}@acme.test`,
          passwordHash: 'no-se-usa-en-este-test',
        },
      }),
    );

    const token = await tokenConRol(acme, 'AGENT');
    const miembros = await miembrosDe(token);

    expect(miembros.map((m) => m.userId)).not.toContain(sueltoId);
  });

  // ------------------------------------------------------------ autorización

  /**
   * El caso que justifica el ADR-0025. Un VIEWER es el cliente final: el
   * listado completo de empleados en sus manos es una lista de correos
   * cosechable para phishing y una radiografía de la plantilla.
   */
  it('un VIEWER recibe 403', async () => {
    const token = await tokenConRol(acme, 'VIEWER');
    await listar(token).expect(403);
  });

  it('sin token recibe 401', async () => {
    await request(app.getHttpServer()).get('/members').expect(401);
  });

  // --------------------------------------------------------------- aislamiento

  it('el ADMIN de otra organización no ve ni un miembro de la primera', async () => {
    const token = await tokenConRol(otra, 'ADMIN');
    const miembros = await miembrosDe(token);

    expect(miembros.map((m) => m.userId)).toEqual([otra.userId]);
  });

  /**
   * Comprobación por CONTENIDO y no por conteo: contar filas no detecta una
   * mezcla si las dos organizaciones tienen el mismo tamaño.
   */
  it('ningún email se cruza entre organizaciones', async () => {
    const deAcme = await miembrosDe(await tokenConRol(acme, 'AGENT'));
    const deOtra = await miembrosDe(await tokenConRol(otra, 'ADMIN'));

    const emailsAcme = new Set(deAcme.map((m) => m.email));
    for (const miembro of deOtra) {
      expect(emailsAcme.has(miembro.email)).toBe(false);
    }
    expect(deAcme.map((m) => m.email)).toContain(viewerEmail);
    expect(deOtra.map((m) => m.email)).not.toContain(viewerEmail);
  });

  /**
   * Cruza el aislamiento con el consumidor real del endpoint: un `userId`
   * sacado del directorio de una organización no puede servir para asignar en
   * otra. Tiene que ser un 404 del dominio, no un 500 por clave foránea.
   */
  it('un userId de una organización no sirve como assigneeId en otra', async () => {
    const tokenOtra = await tokenConRol(otra, 'ADMIN');
    const ticket = await request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${tokenOtra}`)
      .send({ subject: 'Ajeno', description: 'De la otra organización.' })
      .expect(201);

    const ticketId = (ticket.body as { id: string }).id;

    await request(app.getHttpServer())
      .post(`/tickets/${ticketId}/assign`)
      .set('Authorization', `Bearer ${tokenOtra}`)
      .send({ assigneeId: viewerId })
      .expect(404);
  });

  // ------------------------------------------------------- el bucle completo

  it('el userId devuelto sirve para asignar un ticket', async () => {
    const token = await tokenConRol(acme, 'ADMIN');
    const miembros = await miembrosDe(token);
    const destinatario = miembros.find((m) => m.userId !== acme.userId);
    expect(destinatario).toBeDefined();

    const ticket = await request(app.getHttpServer())
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Para repartir', description: 'Va al directorio.' })
      .expect(201);

    const ticketId = (ticket.body as { id: string }).id;

    const asignado = await request(app.getHttpServer())
      .post(`/tickets/${ticketId}/assign`)
      .set('Authorization', `Bearer ${token}`)
      .send({ assigneeId: destinatario!.userId })
      .expect(201);

    expect((asignado.body as { assigneeId: string }).assigneeId).toBe(
      destinatario!.userId,
    );
  });
});
