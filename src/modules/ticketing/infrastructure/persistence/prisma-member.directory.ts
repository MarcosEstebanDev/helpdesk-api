import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId, UserId } from '../../domain/ids';
import { MemberDirectory } from '../../domain/ports/member.directory';

/**
 * Adapter del puerto {@link MemberDirectory} sobre la tabla `memberships` de
 * `iam`.
 *
 * Que ticketing lea una tabla de otro contexto es una concesión consciente: en
 * un sistema distribuido de verdad esto sería una llamada al servicio de
 * identidad o una vista materializada por eventos. Con un único despliegue y una
 * única base de datos, la consulta directa es honesta y el acoplamiento queda
 * confinado a ESTE fichero, detrás del puerto. Cambiarlo por una llamada remota
 * no tocaría ni el dominio ni los casos de uso.
 */
@Injectable()
export class PrismaMemberDirectory
  extends PrismaRepository
  implements MemberDirectory
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async isMember(tenantId: TenantId, userId: UserId): Promise<boolean> {
    return this.runInTenant(tenantId, async (tx) => {
      const found = await tx.membership.findFirst({
        where: { tenantId, userId },
        select: { id: true },
      });
      return found !== null;
    });
  }
}
