import { TenantId } from '../../domain/ids';
import { SlaPolicyRepository } from '../../domain/ports/sla.repository';
import {
  EffectiveSlaTarget,
  effectivePolicy,
} from '../../domain/sla/sla-policy';

/**
 * Devuelve la política de SLA vigente de la organización: las cuatro
 * prioridades, con el objetivo que rige y de dónde sale cada uno.
 *
 * Es lectura pura, así que no abre transacción ni devuelve `Result`: no hay
 * ninguna decisión de negocio que pueda salir mal. Existe como caso de uso —y no
 * como read model tirando de la tabla— porque la respuesta NO está en la base de
 * datos: `sla_policies` solo guarda los overrides, y completar los huecos con
 * `DEFAULT_SLA_POLICY` es una regla del dominio.
 */
export class GetSlaPolicy {
  constructor(private readonly policies: SlaPolicyRepository) {}

  async execute(input: { tenantId: TenantId }): Promise<EffectiveSlaTarget[]> {
    const overrides = await this.policies.overridesOf(input.tenantId);
    return effectivePolicy(overrides);
  }
}
