import { DEFAULT_SLA_POLICY } from '../../domain/sla/sla-policy';
import { AuditRecorder } from '../audit-recorder';
import {
  ACTOR,
  TENANT,
  fakeAuditLogRepository,
  fakeSlaPolicies,
  fakeTransactions,
  fixedClock,
  sequentialIds,
} from '../ticketing.test-doubles';
import { GetSlaPolicy } from './get-sla-policy.use-case';
import { ResetSlaPolicy } from './reset-sla-policy.use-case';
import { UpdateSlaPolicy } from './update-sla-policy.use-case';

const AHORA = new Date('2026-09-09T10:00:00.000Z');

const montar = (iniciales = {}) => {
  const policies = fakeSlaPolicies(iniciales);
  const auditLogs = fakeAuditLogRepository();
  const transactions = fakeTransactions();
  const audit = new AuditRecorder(sequentialIds(), auditLogs);
  const clock = fixedClock(AHORA);

  return {
    policies,
    auditLogs,
    transactions,
    get: new GetSlaPolicy(policies),
    update: new UpdateSlaPolicy(transactions.manager, policies, audit, clock),
    reset: new ResetSlaPolicy(transactions.manager, policies, audit, clock),
  };
};

describe('GetSlaPolicy', () => {
  it('una organización que no ha configurado nada ya tiene política', async () => {
    // El caso que justifica que exista este caso de uso: la respuesta NO está
    // en la tabla, que está vacía. Sale de `DEFAULT_SLA_POLICY`.
    const { get } = montar();

    const vigente = await get.execute({ tenantId: TENANT });

    expect(vigente).toHaveLength(4);
    expect(vigente.every((t) => t.source === 'default')).toBe(true);
  });

  it('distingue lo pactado de lo que viene de fábrica', async () => {
    const { get } = montar({
      URGENT: { responseMinutes: 5, resolutionMinutes: 30 },
    });

    const vigente = await get.execute({ tenantId: TENANT });

    expect(vigente.find((t) => t.priority === 'URGENT')).toEqual({
      priority: 'URGENT',
      responseMinutes: 5,
      resolutionMinutes: 30,
      source: 'organization',
    });
    expect(vigente.find((t) => t.priority === 'LOW')?.source).toBe('default');
  });
});

describe('UpdateSlaPolicy', () => {
  const cambiar = (
    update: UpdateSlaPolicy,
    responseMinutes = 5,
    resolutionMinutes = 30,
  ) =>
    update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      priority: 'URGENT',
      responseMinutes,
      resolutionMinutes,
    });

  it('guarda el objetivo y devuelve la política ya actualizada', async () => {
    const { update, policies } = montar();

    const resultado = await cambiar(update);

    expect(resultado.isOk()).toBe(true);
    if (resultado.isOk()) {
      expect(resultado.value.find((t) => t.priority === 'URGENT')).toEqual({
        priority: 'URGENT',
        responseMinutes: 5,
        resolutionMinutes: 30,
        source: 'organization',
      });
      // Las demás no se tocan: el cambio es por prioridad, no de la tabla entera.
      expect(resultado.value.find((t) => t.priority === 'HIGH')).toMatchObject({
        ...DEFAULT_SLA_POLICY.HIGH,
        source: 'default',
      });
    }
    expect(policies.overrides.URGENT).toEqual({
      responseMinutes: 5,
      resolutionMinutes: 30,
    });
  });

  it('deja rastro de auditoría con el valor anterior y el nuevo', async () => {
    // Sin el `before`, el rastro dice que alguien cambió el SLA pero no desde
    // qué compromiso, que es justo el dato que hace falta al discutir después
    // un incumplimiento.
    const { update, auditLogs } = montar();

    await cambiar(update);

    const entrada = auditLogs.entries[0];
    expect(entrada.action).toBe('sla.policy_changed');
    expect(entrada.entityId).toBe(TENANT);
    expect(entrada.metadata).toEqual({
      priority: 'URGENT',
      before: {
        priority: 'URGENT',
        ...DEFAULT_SLA_POLICY.URGENT,
        source: 'default',
      },
      after: { responseMinutes: 5, resolutionMinutes: 30 },
    });
    expect(entrada.occurredAt).toBe(AHORA);
  });

  it('rechaza prometer resolver antes que responder sin tocar nada', async () => {
    const { update, policies, auditLogs, transactions } = montar();

    const resultado = await update.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      priority: 'URGENT',
      responseMinutes: 240,
      resolutionMinutes: 30,
    });

    expect(resultado.isErr()).toBe(true);
    if (resultado.isErr())
      expect(resultado.error.code).toBe('ticketing.invalid_sla_target');
    expect(policies.upserts).toBe(0);
    expect(auditLogs.entries).toHaveLength(0);
    // Ni siquiera se abre transacción: la validación es pura y no necesita la
    // base de datos para saber que el objetivo es incoherente.
    expect(transactions.commits).toBe(0);
  });
});

describe('ResetSlaPolicy', () => {
  it('devuelve la prioridad al valor por defecto', async () => {
    const { reset, policies } = montar({
      URGENT: { responseMinutes: 5, resolutionMinutes: 30 },
    });

    const vigente = await reset.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      priority: 'URGENT',
    });

    expect(vigente.find((t) => t.priority === 'URGENT')).toEqual({
      priority: 'URGENT',
      ...DEFAULT_SLA_POLICY.URGENT,
      source: 'default',
    });
    expect(policies.overrides.URGENT).toBeUndefined();
  });

  it('resetear lo que ya está por defecto no ensucia la auditoría', async () => {
    // Es idempotente por diseño: un DELETE repetido no debe generar entradas
    // que digan que hubo un cambio cuando no lo hubo.
    const { reset, auditLogs } = montar();

    await reset.execute({
      tenantId: TENANT,
      actorId: ACTOR,
      priority: 'URGENT',
    });

    expect(auditLogs.entries).toHaveLength(0);
  });
});
