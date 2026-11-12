import { Prisma } from '@prisma/client';
import { DuplicateTagNameError, TagNotFoundError } from '../../domain/errors';
import { carreraComoErrorDeEtiqueta } from './prisma-races';

const errorPrisma = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('carrera', {
    code,
    clientVersion: 'test',
  });

describe('carreraComoErrorDeEtiqueta (ADR-0031)', () => {
  it('una FK rota (un ADMIN borró la etiqueta a la vez) es "la etiqueta no existe"', () => {
    expect(carreraComoErrorDeEtiqueta(errorPrisma('P2003'))).toBeInstanceOf(
      TagNotFoundError,
    );
  });

  it('una unicidad rota (dos crean el mismo nombre a la vez) es un duplicado', () => {
    expect(carreraComoErrorDeEtiqueta(errorPrisma('P2002'))).toBeInstanceOf(
      DuplicateTagNameError,
    );
  });

  it('cualquier otro error no se disfraza', () => {
    expect(carreraComoErrorDeEtiqueta(errorPrisma('P2028'))).toBeNull();
    expect(carreraComoErrorDeEtiqueta(new Error('otra cosa'))).toBeNull();
  });
});
