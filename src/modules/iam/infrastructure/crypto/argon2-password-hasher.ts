import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import type { Algorithm } from '@node-rs/argon2';
import { PasswordHasher } from '../../domain/ports/password-hasher';
import { Password } from '../../domain/value-objects/password.vo';
import { PasswordHash } from '../../domain/value-objects/password-hash.vo';

/**
 * Adapter de {@link PasswordHasher} con **argon2id** (ADR-0011).
 *
 * Se usa `@node-rs/argon2` en vez de `argon2`: trae binarios precompilados
 * (napi-rs) y no ejecuta scripts de build, lo que encaja con la política
 * `allowBuilds` de pnpm 11 de este repo. Es un detalle de implementación
 * IRRELEVANTE para el dominio — exactamente lo que el puerto hace intercambiable.
 *
 * Parámetros: los recomendados por OWASP para argon2id (19 MiB, 2 iteraciones,
 * paralelismo 1). Suben el coste de un ataque por diccionario sin penalizar
 * el login (~50 ms).
 */
// `Algorithm` se declara como `const enum` ambiente en @node-rs/argon2, y con
// `isolatedModules` TypeScript no puede leer su valor en tiempo de compilación.
// 2 es Argon2id (0 = Argon2d, 1 = Argon2i). Se deja explícito en vez de confiar
// en el valor por defecto: un parámetro de seguridad no debería ser implícito.
const ARGON2ID = 2 as Algorithm;

const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB = 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  async hash(password: Password): Promise<PasswordHash> {
    return PasswordHash.fromHash(await hash(password.value, PARAMS));
  }

  async verify(plain: string, stored: PasswordHash): Promise<boolean> {
    try {
      return await verify(stored.value, plain, PARAMS);
    } catch {
      // Un hash corrupto o de otro algoritmo no es un fallo del sistema:
      // es simplemente una credencial que no valida.
      return false;
    }
  }
}
