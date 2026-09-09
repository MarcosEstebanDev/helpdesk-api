import {
  DEFAULT_SLA_POLICY,
  SLA_MAX_MINUTES,
  effectivePolicy,
  makeSlaTarget,
  resolvePolicy,
} from './sla-policy';

describe('resolvePolicy', () => {
  it('sin configuración devuelve la política por defecto completa', () => {
    // Una organización que nunca tocó nada tiene SLA igualmente: por eso el
    // valor por defecto vive en el dominio y no en filas sembradas al registrar.
    expect(resolvePolicy({})).toEqual(DEFAULT_SLA_POLICY);
  });

  it('permite endurecer UNA prioridad sin declarar las demás', () => {
    const politica = resolvePolicy({
      URGENT: { responseMinutes: 5, resolutionMinutes: 60 },
    });

    expect(politica.URGENT).toEqual({
      responseMinutes: 5,
      resolutionMinutes: 60,
    });
    expect(politica.HIGH).toEqual(DEFAULT_SLA_POLICY.HIGH);
    expect(politica.NORMAL).toEqual(DEFAULT_SLA_POLICY.NORMAL);
    expect(politica.LOW).toEqual(DEFAULT_SLA_POLICY.LOW);
  });

  it('los objetivos por defecto son más estrictos cuanto mayor la prioridad', () => {
    // Es una invariante del producto, no un detalle: si alguien edita los
    // valores y rompe el orden, esto lo delata.
    const orden = ['URGENT', 'HIGH', 'NORMAL', 'LOW'] as const;

    for (let i = 0; i < orden.length - 1; i += 1) {
      const mayor = DEFAULT_SLA_POLICY[orden[i]];
      const menor = DEFAULT_SLA_POLICY[orden[i + 1]];
      expect(mayor.responseMinutes).toBeLessThan(menor.responseMinutes);
      expect(mayor.resolutionMinutes).toBeLessThan(menor.resolutionMinutes);
    }
  });
});

describe('makeSlaTarget', () => {
  it('acepta un objetivo coherente', () => {
    const target = makeSlaTarget({
      responseMinutes: 30,
      resolutionMinutes: 240,
    });

    expect(target.isOk()).toBe(true);
    if (target.isOk())
      expect(target.value).toEqual({
        responseMinutes: 30,
        resolutionMinutes: 240,
      });
  });

  it('rechaza prometer resolver antes que responder', () => {
    // La regla interesante: no es un objetivo "estricto", es incoherente. El
    // motor lo aceptaría sin rechistar porque los dos relojes son independientes.
    const target = makeSlaTarget({
      responseMinutes: 240,
      resolutionMinutes: 30,
    });

    expect(target.isErr()).toBe(true);
    if (target.isErr())
      expect(target.error.code).toBe('ticketing.invalid_sla_target');
  });

  it('permite que respuesta y resolución coincidan', () => {
    // El borde: "contéstame y arréglalo dentro de la misma hora" es raro, pero
    // no es contradictorio.
    expect(
      makeSlaTarget({ responseMinutes: 60, resolutionMinutes: 60 }).isOk(),
    ).toBe(true);
  });

  it.each([
    ['cero', { responseMinutes: 0, resolutionMinutes: 60 }],
    ['negativo', { responseMinutes: -5, resolutionMinutes: 60 }],
    ['decimal', { responseMinutes: 1.5, resolutionMinutes: 60 }],
    [
      'más de un año',
      { responseMinutes: 1, resolutionMinutes: SLA_MAX_MINUTES + 1 },
    ],
  ])('rechaza un objetivo %s', (_caso, entrada) => {
    expect(makeSlaTarget(entrada).isErr()).toBe(true);
  });
});

describe('effectivePolicy', () => {
  it('marca de dónde sale cada objetivo', () => {
    // Sin `source`, un administrador no puede distinguir "lo pactamos así" de
    // "nadie lo tocó nunca", que es lo que necesita saber antes de cambiarlo.
    const vigente = effectivePolicy({
      URGENT: { responseMinutes: 5, resolutionMinutes: 30 },
    });

    const urgente = vigente.find((t) => t.priority === 'URGENT');
    expect(urgente).toEqual({
      priority: 'URGENT',
      responseMinutes: 5,
      resolutionMinutes: 30,
      source: 'organization',
    });

    const normal = vigente.find((t) => t.priority === 'NORMAL');
    expect(normal).toMatchObject({
      ...DEFAULT_SLA_POLICY.NORMAL,
      source: 'default',
    });
  });

  it('devuelve SIEMPRE las cuatro prioridades', () => {
    expect(effectivePolicy({})).toHaveLength(4);
  });
});
