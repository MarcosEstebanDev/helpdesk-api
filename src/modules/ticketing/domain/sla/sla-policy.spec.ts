import { DEFAULT_SLA_POLICY, resolvePolicy } from './sla-policy';

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
