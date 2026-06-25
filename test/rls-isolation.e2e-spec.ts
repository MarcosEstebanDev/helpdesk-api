import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/infrastructure/prisma/prisma.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';

/**
 * Test estrella de la Fase 2: demuestra que el aislamiento multi-tenant lo
 * garantiza la base de datos (Row-Level Security, ADR-0010), no la aplicación.
 * Corre con el rol de app RESTRINGIDO (DATABASE_URL), nunca con el owner.
 */
describe('RLS tenant isolation (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const orgA = randomUUID();
  const orgB = randomUUID();

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    // Cada tenant se siembra bajo SU propio contexto: el WITH CHECK de la policy
    // sólo deja insertar filas cuyo tenant coincide con app.current_tenant.
    await prisma.withTenant(orgA, async (tx) => {
      await tx.organization.create({
        data: { id: orgA, name: 'Org A', slug: `org-a-${orgA}` },
      });
      await tx.user.create({
        data: { tenantId: orgA, email: 'user@org-a.test', passwordHash: 'x' },
      });
    });
    await prisma.withTenant(orgB, async (tx) => {
      await tx.organization.create({
        data: { id: orgB, name: 'Org B', slug: `org-b-${orgB}` },
      });
      await tx.user.create({
        data: { tenantId: orgB, email: 'user@org-b.test', passwordHash: 'x' },
      });
    });
  });

  afterAll(async () => {
    // Cada tenant borra lo suyo bajo su contexto (el cascade respeta RLS).
    await prisma.withTenant(orgA, (tx) =>
      tx.organization.deleteMany({ where: { id: orgA } }),
    );
    await prisma.withTenant(orgB, (tx) =>
      tx.organization.deleteMany({ where: { id: orgB } }),
    );
    await app.close();
  });

  it('cada tenant ve únicamente sus propios usuarios', async () => {
    const aUsers = await prisma.withTenant(orgA, (tx) => tx.user.findMany());
    const bUsers = await prisma.withTenant(orgB, (tx) => tx.user.findMany());

    expect(aUsers).toHaveLength(1);
    expect(aUsers[0].email).toBe('user@org-a.test');
    expect(bUsers).toHaveLength(1);
    expect(bUsers[0].email).toBe('user@org-b.test');
  });

  it('un tenant no puede leer un usuario de otro ni conociendo su id', async () => {
    const [aUser] = await prisma.withTenant(orgA, (tx) => tx.user.findMany());

    const leaked = await prisma.withTenant(orgB, (tx) =>
      tx.user.findUnique({ where: { id: aUser.id } }),
    );

    expect(leaked).toBeNull();
  });

  it('sin contexto de tenant no devuelve ninguna fila (fail-closed)', async () => {
    // Query fuera de withTenant: app.current_tenant no está seteado => NULL =>
    // la policy no matchea ninguna fila.
    const users = await prisma.user.findMany();

    expect(users).toHaveLength(0);
  });

  it('no permite insertar un usuario en otro tenant (WITH CHECK)', async () => {
    await expect(
      prisma.withTenant(orgB, (tx) =>
        tx.user.create({
          data: {
            tenantId: orgA,
            email: 'intruso@org-a.test',
            passwordHash: 'x',
          },
        }),
      ),
    ).rejects.toThrow();
  });
});
