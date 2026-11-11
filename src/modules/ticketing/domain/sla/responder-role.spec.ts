import { countsAsResponse, isResponder } from './responder-role';

describe('quién responde en nombre de la organización', () => {
  it('AGENT y ADMIN responden; el cliente (VIEWER) no', () => {
    expect(['ADMIN', 'AGENT', 'VIEWER'].map(isResponder)).toEqual([
      true,
      true,
      false,
    ]);
  });

  describe('countsAsResponse (ADR-0028)', () => {
    it('una respuesta pública del equipo cuenta', () => {
      expect(
        countsAsResponse({ authorRole: 'AGENT', visibility: 'PUBLIC' }),
      ).toBe(true);
    });

    it('una nota interna no cuenta, la escriba quien la escriba', () => {
      expect(
        countsAsResponse({ authorRole: 'ADMIN', visibility: 'INTERNAL' }),
      ).toBe(false);
    });

    it('el comentario del cliente no cuenta aunque sea público', () => {
      expect(
        countsAsResponse({ authorRole: 'VIEWER', visibility: 'PUBLIC' }),
      ).toBe(false);
    });
  });
});
