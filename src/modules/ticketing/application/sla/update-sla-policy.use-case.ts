import {
  Clock,
  Result,
  TransactionManager,
  err,
  ok,
} from '../../../../shared-kernel';
import { TicketingError } from '../../domain/errors';
import { TenantId, UserId } from '../../domain/ids';
import { SlaPolicyRepository } from '../../domain/ports/sla.repository';
import {
  EffectiveSlaTarget,
  effectivePolicy,
  makeSlaTarget,
} from '../../domain/sla/sla-policy';
import { TicketPriority } from '../../domain/ticket-status';
import { AuditRecorder } from '../audit-recorder';
import { runTransactional } from '../transactional';

export interface UpdateSlaPolicyInput {
  tenantId: TenantId;
  actorId: UserId;
  priority: TicketPriority;
  responseMinutes: number;
  resolutionMinutes: number;
}

/**
 * Cambia el objetivo de SLA de UNA prioridad (ADR-0020).
 *
 * Por prioridad y no la política entera a la vez: enviar las cuatro obligaría al
 * cliente a reenviar lo que no está tocando, y dos administradores editando
 * prioridades distintas se pisarían el trabajo sin enterarse.
 *
 * El cambio y su registro de auditoría van en la MISMA transacción (ADR-0016).
 * Aquí importa especialmente: la política dice qué se prometió, y una promesa
 * que cambia sin dejar rastro de quién la cambió no sirve para discutir después
 * un incumplimiento.
 *
 * Los relojes YA en marcha no se recalculan: `due_at` se fija al arrancar
 * (ADR-0020) justo para que cambiar las reglas a mitad de partida no convierta
 * en incumplidos —ni en cumplidos— tickets que ya estaban corriendo.
 */
export class UpdateSlaPolicy {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly policies: SlaPolicyRepository,
    private readonly audit: AuditRecorder,
    private readonly clock: Clock,
  ) {}

  async execute(
    input: UpdateSlaPolicyInput,
  ): Promise<Result<EffectiveSlaTarget[], TicketingError>> {
    const target = makeSlaTarget({
      responseMinutes: input.responseMinutes,
      resolutionMinutes: input.resolutionMinutes,
    });
    // Se reenvuelve en vez de devolver `target` tal cual: `Err<T, E>` está
    // parametrizado también por el tipo de éxito, y el de `makeSlaTarget` es
    // `SlaTarget`, no la política vigente que devuelve este caso de uso.
    if (target.isErr()) return err(target.error);

    return runTransactional<EffectiveSlaTarget[], TicketingError>(
      this.transactions,
      input.tenantId,
      async () => {
        const overrides = await this.policies.overridesOf(input.tenantId);
        const antes = effectivePolicy(overrides).find(
          (t) => t.priority === input.priority,
        );

        const now = this.clock.now();
        await this.policies.upsert({
          tenantId: input.tenantId,
          priority: input.priority,
          target: target.value,
          now,
        });

        await this.audit.record({
          tenantId: input.tenantId,
          actorId: input.actorId,
          action: 'sla.policy_changed',
          entityType: 'SlaPolicy',
          // La entidad auditada es la política de ESTA organización, así que su
          // identidad es el tenant. No se usa el id de la fila de `sla_policies`
          // porque un reset la borra y el siguiente cambio crea otra con id
          // nuevo: el historial quedaría partido en trozos inconexos. La
          // prioridad concreta viaja en `metadata`.
          entityId: input.tenantId,
          metadata: {
            priority: input.priority,
            before: antes,
            after: target.value,
          },
          now,
        });

        return ok(
          effectivePolicy({ ...overrides, [input.priority]: target.value }),
        );
      },
    );
  }
}
