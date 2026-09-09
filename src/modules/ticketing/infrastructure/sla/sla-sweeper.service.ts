import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../infrastructure/config/env.schema';
import { PrismaService } from '../../../../infrastructure/prisma/prisma.service';
import { MarkSlaBreached } from '../../application/sla/mark-sla-breached.use-case';
import { SlaTimerId, TenantId } from '../../domain/ids';

interface DueTimerRow {
  id: string;
  tenant_id: string;
}

/**
 * Barrido que detecta los SLA vencidos (ADR-0021).
 *
 * **Por qué un barrido y no un job retardado.** Con `delay` de BullMQ el reloj
 * lo sostiene Redis: si Redis se vacía, desaparecen TODOS los vencimientos
 * pendientes en silencio y nadie se entera hasta que un cliente reclama. Con la
 * tabla como fuente de verdad, un Redis nuevo no pierde nada y además se puede
 * consultar "qué tickets están a punto de vencer", que es media pantalla de
 * cualquier panel de soporte. El precio es la precisión: el incumplimiento se
 * detecta con el retraso del intervalo, que para un SLA medido en horas sobra.
 *
 * **La lectura cruza tenants; el trabajo no.** `sla_due_timers` es una función
 * SECURITY DEFINER que devuelve solo `(id, tenant_id)`. Con ese par, cada reloj
 * se procesa dentro de `withTenant`, bajo RLS normal. La excepción al
 * aislamiento se reduce a dos columnas y a una lectura — bastante menos que en
 * el publicador del outbox, que sí recibe el payload entero.
 */
@Injectable()
export class SlaSweeper implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SlaSweeper.name);
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly markBreached: MarkSlaBreached,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.get('WORKER_ENABLED', { infer: true })) {
      this.logger.log('Barrido de SLA desactivado (WORKER_ENABLED=0)');
      return;
    }
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Un barrido. Devuelve cuántos relojes se marcaron como incumplidos.
   *
   * Público y sin temporizador, igual que `OutboxPublisher.publishPending()`:
   * los tests piden un barrido concreto en vez de esperar a que salte un
   * intervalo.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    const limit = this.config.get('SLA_SWEEP_BATCH_SIZE', { infer: true });

    const vencidos = await this.prisma.$queryRaw<DueTimerRow[]>`
      SELECT * FROM sla_due_timers(${limit}::int, ${now}::timestamp(3))
    `;

    let incumplidos = 0;
    for (const fila of vencidos) {
      // Cada reloj va en su propia transacción, con el contexto de SU tenant.
      // Un fallo en uno no debe impedir que se procesen los demás.
      try {
        const result = await this.markBreached.execute({
          tenantId: TenantId(fila.tenant_id),
          timerId: SlaTimerId(fila.id),
        });
        if (result.isOk() && result.value.status === 'breached') {
          incumplidos += 1;
        }
      } catch (error) {
        this.logger.error(
          `Fallo marcando el SLA ${fila.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return incumplidos;
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    const interval = this.config.get('SLA_SWEEP_INTERVAL_MS', { infer: true });
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, interval);
    this.timer.unref();
  }

  /** Nunca lanza: una excepción mataría el bucle y los SLA dejarían de vigilarse. */
  private async tick(): Promise<void> {
    try {
      const incumplidos = await this.sweep();
      if (incumplidos > 0) {
        this.logger.warn(`${incumplidos} SLA incumplidos`);
      }
    } catch (error) {
      this.logger.error(
        `Fallo en el barrido de SLA: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
