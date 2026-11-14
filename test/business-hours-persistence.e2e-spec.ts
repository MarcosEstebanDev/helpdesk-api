import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { PrismaModule } from '../src/infrastructure/prisma/prisma.module';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service';
import { TenantId } from '../src/modules/ticketing/domain/ids';
import { PrismaBusinessCalendarRepository } from '../src/modules/ticketing/infrastructure/persistence/prisma-business-calendar.repository';

/**
 * Persistencia del horario laboral (ADR-0034): defaults sin fila, upsert de la
 * semana, excepciones que no se pisan, y aislamiento por RLS.
 */
describe('Horario laboral: persistencia (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let repo: PrismaBusinessCalendarRepository;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const ahora = new Date('2026-11-13T15:00:00.000Z');

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [PrismaBusinessCalendarRepository],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    repo = app.get(PrismaBusinessCalendarRepository);
    for (const id of [orgA, orgB]) {
      await prisma.withTenant(id, (tx) =>
        tx.organization.create({
          data: { id, name: `Org ${id}`, slug: `bh-${id}` },
        }),
      );
    }
  });

  afterAll(async () => {
    for (const id of [orgA, orgB]) {
      await prisma.withTenant(id, (tx) =>
        tx.organization.deleteMany({ where: { id } }),
      );
    }
    await app.close();
  });

  it('sin configurar devuelve el horario por defecto', async () => {
    const c = await repo.configOf(TenantId(orgA));
    expect(c.source).toBe('default');
    expect(c.mode).toBe('business_hours');
    expect(c.week).toEqual({
      timeZone: 'America/Argentina/Buenos_Aires',
      weekdays: [1, 2, 3, 4, 5],
      opensAtMinute: 480,
      closesAtMinute: 1080,
    });
    expect(c.exceptions).toEqual([]);
  });

  it('guarda la semana y el modo, y en 24/7 conserva la semana', async () => {
    const week = {
      timeZone: 'America/Argentina/Cordoba',
      weekdays: [1, 2, 3, 4, 5, 6] as const,
      opensAtMinute: 540,
      closesAtMinute: 1020,
    };
    await repo.saveWeek({
      tenantId: TenantId(orgA),
      mode: '24_7',
      week: { ...week, weekdays: [...week.weekdays] },
      now: ahora,
    });

    const c = await repo.configOf(TenantId(orgA));
    expect(c.source).toBe('organization');
    expect(c.mode).toBe('24_7');
    expect(c.config).toEqual({ mode: '24_7' });
    expect(c.week).toEqual({ ...week, weekdays: [1, 2, 3, 4, 5, 6] });
  });

  it('una fecha no se carga dos veces y la existente no se pisa', async () => {
    const id = TenantId(orgA);
    const navidad = { date: '2026-12-25', working: false, name: 'Navidad' };
    expect(
      await repo.addException({
        tenantId: id,
        id: randomUUID(),
        exception: navidad,
        now: ahora,
      }),
    ).toBe('added');
    expect(
      await repo.addException({
        tenantId: id,
        id: randomUUID(),
        exception: { ...navidad, name: 'Otra' },
        now: ahora,
      }),
    ).toBe('duplicate');

    const agregadas = await repo.addExceptions({
      tenantId: id,
      items: [
        {
          id: randomUUID(),
          exception: { date: '2026-12-25', working: true, name: 'Pisa' },
        },
        {
          id: randomUUID(),
          exception: { date: '2026-12-08', working: false, name: 'Inmaculada' },
        },
      ],
      now: ahora,
    });
    expect(agregadas).toBe(1);

    const c = await repo.configOf(id);
    expect(c.exceptions.map((e) => [e.date, e.name, e.working])).toEqual([
      ['2026-12-08', 'Inmaculada', false],
      ['2026-12-25', 'Navidad', false],
    ]);
  });

  it('borrar devuelve si existía', async () => {
    const id = TenantId(orgA);
    const [primera] = (await repo.configOf(id)).exceptions;
    expect(await repo.removeException(id, primera.id)).toBe(true);
    expect(await repo.removeException(id, primera.id)).toBe(false);
  });

  it('otra organización no ve nada de esto (RLS)', async () => {
    const c = await repo.configOf(TenantId(orgB));
    expect(c.source).toBe('default');
    expect(c.exceptions).toEqual([]);
  });
});
