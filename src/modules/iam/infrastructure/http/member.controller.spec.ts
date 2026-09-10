import 'reflect-metadata';
import type { Prisma } from '@prisma/client';
import { MIN_ROLE_KEY } from '../auth/min-role.decorator';
import { TenantId } from '../../domain/ids';
import { MemberReadModel } from '../persistence/member.read-model';
import { MemberController } from './member.controller';
import type { PrismaService } from '../../../../infrastructure/prisma/prisma.service';

/**
 * `PrismaService` de mentira: `withTenant` invoca la función con el `tx` que se
 * le pase. Basta para probar la proyección sin base de datos — el aislamiento
 * real por RLS se prueba en los e2e, que es donde puede probarse de verdad.
 */
const prismaFalso = (filas: unknown[]): PrismaService =>
  ({
    withTenant: <T>(
      _tenantId: string,
      fn: (tx: Prisma.TransactionClient) => Promise<T>,
    ) =>
      fn({
        membership: { findMany: () => Promise.resolve(filas) },
      } as unknown as Prisma.TransactionClient),
  }) as unknown as PrismaService;

describe('MemberController', () => {
  /**
   * Fija la decisión de seguridad del ADR-0025 en un test.
   *
   * Sin esto, bajar el rango a VIEWER sería un cambio de una palabra que nadie
   * nota en una revisión; con esto, es un diff que hay que justificar.
   */
  it('el listado exige AGENT o superior', () => {
    const rango: unknown = Reflect.getMetadata(
      MIN_ROLE_KEY,
      MemberController.prototype.list,
    );

    expect(rango).toBe('AGENT');
  });

  /**
   * `users` guarda `password_hash` en la MISMA tabla que el email. Hoy no puede
   * filtrarse porque el `select` es explícito, pero este test es lo que impide
   * que un refactor futuro a `...row` lo deje pasar sin que nadie se entere.
   */
  it('la proyección descarta cualquier campo que no sean los cuatro del contrato', async () => {
    const readModel = new MemberReadModel(
      prismaFalso([
        {
          role: 'AGENT',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          tenantId: 'no-debería-salir',
          user: {
            id: 'u1',
            email: 'ana@acme.test',
            passwordHash: 'no-debería-salir',
          },
        },
      ]),
    );

    const [miembro] = await readModel.list(TenantId('t1'));

    expect(Object.keys(miembro).sort()).toEqual([
      'email',
      'joinedAt',
      'role',
      'userId',
    ]);
  });
});
