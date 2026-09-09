import { Clock, TransactionManager } from '../../../../shared-kernel';
import { TenantId, UserId } from '../../domain/ids';
import { SlaPolicyRepository } from '../../domain/ports/sla.repository';
import {
  EffectiveSlaTarget,
  effectivePolicy,
} from '../../domain/sla/sla-policy';
import { TicketPriority } from '../../domain/ticket-status';
import { AuditRecorder } from '../audit-recorder';

export interface ResetSlaPolicyInput {
  tenantId: TenantId;
  actorId: UserId;
  priority: TicketPriority;
}

/**
 * Devuelve una prioridad al objetivo por defecto del producto, quitando el
 * override de la organización.
 *
 * No devuelve `Result`: quitar algo que no está es idempotente, no un error, así
 * que no hay ningún fallo de negocio que representar. Sí abre transacción,
 * porque el borrado y su auditoría tienen que ser atómicos igual que en
 * `UpdateSlaPolicy` — pero le basta `transactions.run`: `runTransactional` solo
 * existe para convertir un `Err` en rollback, y aquí no puede haberlo.
 *
 * Solo audita si de verdad había un override. Un DELETE repetido no debe llenar
 * el rastro de entradas que dicen que no pasó nada.
 */
export class ResetSlaPolicy {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly policies: SlaPolicyRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(input: ResetSlaPolicyInput): Promise<EffectiveSlaTarget[]> {
    return this.transactions.run(input.tenantId, async () => {
      const overrides = await this.policies.overridesOf(input.tenantId);
      const antes = effectivePolicy(overrides).find(
        (t) => t.priority === input.priority,
      );

      const habia = await this.policies.remove(input.tenantId, input.priority);

      // Se relee dentro de la MISMA transacción en vez de quitar la clave a mano
      // del objeto anterior: así lo que se devuelve y lo que se audita es el
      // estado real tras el borrado, sin una segunda copia de la regla.
      const vigente = effectivePolicy(
        await this.policies.overridesOf(input.tenantId),
      );

      if (habia) {
        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'sla.policy_changed',
          entityType: 'SlaPolicy',
          entityId: input.tenantId,
          metadata: {
            priority: input.priority,
            before: antes,
            after: vigente.find((t) => t.priority === input.priority),
            reset: true,
          },
          now: this.clock.now(),
        });
      }

      return vigente;
    });
  }
}
