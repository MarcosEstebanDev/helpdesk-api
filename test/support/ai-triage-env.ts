/**
 * Entorno de `ai-triage.e2e-spec.ts`. Tiene que ser el PRIMER import de esa
 * suite: `ConfigModule.forRoot` valida `process.env` en cuanto se importa
 * `AppModule`, así que fijar las variables dentro de `beforeAll` llegaría tarde.
 *
 * Puerto fijo porque la URL tiene que conocerse antes de levantar el servidor
 * falso. Está lejos de los que usa el proyecto (3000, 3001, 5432, 6379, 8000).
 */
export const PUERTO_IA_FALSA = 18_765;
export const TOKEN_INTERNO = 'token-interno-de-prueba-e2e';

export const ENV_ANTERIOR = {
  url: process.env.AI_SERVICE_URL,
  token: process.env.AI_SERVICE_TOKEN,
};

process.env.AI_SERVICE_URL = `http://127.0.0.1:${PUERTO_IA_FALSA}`;
process.env.AI_SERVICE_TOKEN = TOKEN_INTERNO;
process.env.THROTTLE_SKIP = '1';
