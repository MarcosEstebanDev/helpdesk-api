import { nationalHolidays } from './argentina-holidays';

describe('nationalHolidays (feriados nacionales de Argentina)', () => {
  it('2026 trae los inamovibles, todos no hábiles', () => {
    const fechas = nationalHolidays(2026)!.map((f) => f.date);
    for (const d of [
      '01-01',
      '03-24',
      '04-02',
      '05-01',
      '05-25',
      '06-20',
      '07-09',
      '12-08',
      '12-25',
    ]) {
      expect(fechas).toContain(`2026-${d}`);
    }
    expect(nationalHolidays(2026)!.every((f) => !f.working)).toBe(true);
  });

  it('los trasladables ya vienen movidos (Ley 27.399)', () => {
    const fechas = nationalHolidays(2026)!.map((f) => f.date);
    // Güemes 17/6 cae miércoles → lunes 15/6; Soberanía 20/11 viernes → lunes 23/11.
    expect(fechas).toContain('2026-06-15');
    expect(fechas).not.toContain('2026-06-17');
    expect(fechas).toContain('2026-11-23');
  });

  it('no incluye los días que el sector privado suele trabajar', () => {
    const fechas = nationalHolidays(2026)!.map((f) => f.date);
    expect(fechas).not.toContain('2026-12-24');
    expect(fechas).not.toContain('2026-12-31');
  });

  it('fechas únicas, del año pedido, con nombre', () => {
    for (const anio of [2026, 2027]) {
      const lista = nationalHolidays(anio)!;
      expect(new Set(lista.map((f) => f.date)).size).toBe(lista.length);
      expect(
        lista.every((f) => f.date.startsWith(`${anio}-`) && f.name.length > 0),
      ).toBe(true);
    }
  });

  it('un año sin lista devuelve null, no una lista vacía', () => {
    expect(nationalHolidays(2030)).toBeNull();
  });
});
