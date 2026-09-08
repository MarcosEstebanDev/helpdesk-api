import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId } from '../../domain/ids';
import {
  OrganizationRepository,
  ProvisionOrganizationInput,
} from '../../domain/ports/organization.repository';

@Injectable()
export class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async existsBySlug(slug: string): Promise<boolean> {
    return (await this.findIdBySlug(slug)) !== null;
  }

  /**
   * Resuelve slug -> tenant ANTES de conocer el tenant, así que no puede correr
   * dentro de `withTenant`. Usa la función `SECURITY DEFINER` de la migración
   * (ADR-0012), que es la única grieta permitida en RLS: solo lee (id, slug) de
   * `organizations` y nada más.
   */
  async findIdBySlug(slug: string): Promise<TenantId | null> {
    const rows = await this.prisma.$queryRaw<{ id: string | null }[]>`
      SELECT iam_resolve_tenant_by_slug(${slug}) AS id
    `;
    const id = rows.at(0)?.id ?? null;
    return id === null ? null : TenantId(id);
  }

  /**
   * Crea organización + owner + membership en UNA transacción, con el contexto
   * de tenant fijado al id de la organización que se está creando. El `WITH CHECK`
   * de RLS pasa porque el contexto coincide con las filas insertadas.
   */
  async provision(input: ProvisionOrganizationInput): Promise<void> {
    const { organization, owner, membership } = input;

    await this.prisma.withTenant(organization.id, async (tx) => {
      await tx.organization.create({
        data: {
          id: organization.id,
          name: organization.name,
          slug: organization.slug,
          createdAt: organization.createdAt,
        },
      });

      await tx.user.create({
        data: {
          id: owner.id,
          tenantId: owner.tenantId,
          email: owner.email.value,
          passwordHash: owner.passwordHash.value,
          createdAt: owner.createdAt,
        },
      });

      await tx.membership.create({
        data: {
          id: membership.id,
          tenantId: membership.tenantId,
          userId: membership.userId,
          role: membership.role,
          createdAt: membership.createdAt,
        },
      });
    });
  }
}
