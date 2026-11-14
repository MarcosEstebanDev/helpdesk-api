import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '../../../../infrastructure/prisma/prisma.repository';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { TenantId, TicketId } from '../../domain/ids';
import { TicketTriageRepository } from '../../domain/ports/ticket-triage.repository';
import { isTicketPriority } from '../../domain/ticket-status';
import {
  TicketTriage,
  isTriageCategory,
  isTriageLanguage,
  isTriageSentiment,
} from '../../domain/triage/ticket-triage.entity';

@Injectable()
export class PrismaTicketTriageRepository
  extends PrismaRepository
  implements TicketTriageRepository
{
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async save(triage: TicketTriage): Promise<void> {
    const { classification: c, provenance: p } = triage;
    await this.runInTenant(triage.tenantId, async (tx) => {
      // `createMany` + `skipDuplicates` (ON CONFLICT DO NOTHING) y no un
      // try/catch sobre P2002: dentro de una transacción de Postgres, una
      // violación de unicidad aborta la transacción ENTERA (gotcha de la fase 5b).
      await tx.ticketTriage.createMany({
        data: {
          ticketId: triage.ticketId,
          tenantId: triage.tenantId,
          category: c.category,
          suggestedPriority: c.suggestedPriority,
          sentiment: c.sentiment,
          language: c.language,
          provider: p.provider,
          model: p.model,
          promptVersion: p.promptVersion,
          latencyMs: p.latencyMs,
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          triagedAt: triage.triagedAt,
        },
        skipDuplicates: true,
      });
    });
  }

  async findByTicket(
    tenantId: TenantId,
    ticketId: TicketId,
  ): Promise<TicketTriage | null> {
    return this.runInTenant(tenantId, async (tx) => {
      const row = await tx.ticketTriage.findFirst({
        where: { tenantId, ticketId },
      });
      if (row === null) return null;

      const { category, sentiment, language } = row;
      const priority: string = row.suggestedPriority;
      if (
        !isTriageCategory(category) ||
        !isTriageSentiment(sentiment) ||
        !isTriageLanguage(language) ||
        !isTicketPriority(priority)
      ) {
        throw new Error(
          `Triage con valores desconocidos en base de datos (ticket ${row.ticketId}).`,
        );
      }

      return TicketTriage.rehydrate({
        ticketId: TicketId(row.ticketId),
        tenantId: TenantId(row.tenantId),
        classification: {
          category,
          suggestedPriority: priority,
          sentiment,
          language,
        },
        provenance: {
          provider: row.provider,
          model: row.model,
          promptVersion: row.promptVersion,
          latencyMs: row.latencyMs,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
        },
        triagedAt: row.triagedAt,
      });
    });
  }
}
