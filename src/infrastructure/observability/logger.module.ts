import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env.schema';
import { getTenantContext } from '../tenant/tenant-context';
import {
  REQUEST_ID_HEADER,
  getContextTenantId,
  getRequestId,
  sanitizeRequestId,
} from './request-context';

/**
 * Logging estructurado (ADR-0024).
 *
 * Sustituye el logger de Nest en vez de convivir con él: así los mensajes de
 * arranque, los de los workers y los de las excepciones no manejadas salen en el
 * mismo formato que los de las peticiones. Con dos loggers en paralelo, la mitad
 * de lo que pasa en producción queda fuera de las consultas.
 *
 * **Cada línea lleva `requestId` y `tenantId` sin que nadie los pase a mano.**
 * El `mixin` los lee de los `AsyncLocalStorage` en el momento de escribir, así
 * que también aparecen en los logs que emite el dominio a través del logger de
 * Nest, sin acoplar ninguna capa al concepto de "request".
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const entorno = config.get('NODE_ENV', { infer: true });
        const conPrettyPrint = entorno === 'development';

        return {
          pinoHttp: {
            level: config.get('LOG_LEVEL', { infer: true }),

            // `pino-pretty` SOLO en desarrollo, donde los logs se leen. En
            // producción se emite JSON por stdout, que es lo que recoge el
            // agente de logs; y en los tests se evita porque el transport abre
            // un worker thread por aplicación, lo que alarga el cierre de cada
            // suite e2e — llegó a agotar el timeout de un `afterAll`.
            transport: conPrettyPrint
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'HH:MM:ss',
                    ignore: 'pid,hostname',
                  },
                }
              : undefined,

            // Correlación: se respeta el id entrante para no romper la cadena
            // cuando la petición viene de otro servicio; si no hay, se genera.
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              // Si el middleware de correlación ya pasó, se reutiliza su id: dos
              // ids distintos para la misma petición serían peor que ninguno.
              const yaAsignado = sanitizeRequestId(
                (req as { id?: unknown }).id,
              );
              const entrante = sanitizeRequestId(
                req.headers[REQUEST_ID_HEADER],
              );
              const id = yaAsignado ?? entrante ?? randomUUID();
              // Se devuelve al cliente para que pueda citarlo al reportar un
              // problema; sin eso, correlacionar depende de adivinar la hora.
              res.setHeader(REQUEST_ID_HEADER, id);
              return id;
            },

            /**
             * `mixin` y NO `customProps`.
             *
             * `customProps` solo alcanza a la línea de "request completed" que
             * emite `pino-http`. `mixin` se ejecuta en CADA log de la instancia,
             * así que la correlación aparece también en lo que escriben los
             * casos de uso y los workers — que es justo donde hace falta: la
             * línea de acceso HTTP ya se sabe de qué petición es, lo que no se
             * sabe es de cuál viene un job procesado medio segundo después.
             *
             * Se lee del `AsyncLocalStorage` al escribir, así que ninguna capa
             * tiene que pasar el id a mano.
             */
            mixin: () => ({
              requestId: getRequestId(),
              // En una petición sale del usuario autenticado; en un worker, del
              // propio evento. Filtrar los logs por organización funciona igual
              // en los dos casos, que es lo que se necesita para responder a
              // "¿qué le pasó a este cliente?".
              tenantId: getTenantContext()?.tenantId ?? getContextTenantId(),
            }),

            // Un 4xx es un cliente equivocándose, no un fallo del servidor: a
            // nivel `error` ahogaría las alertas que sí importan.
            customLogLevel: (_req, res, err) => {
              if (err !== undefined) return 'error';
              if (res.statusCode >= 500) return 'error';
              if (res.statusCode >= 400) return 'warn';
              return 'info';
            },

            /**
             * Nada de secretos en los logs.
             *
             * `Authorization` y `Cookie` llevan credenciales de sesión: un log
             * con ellas es un log que da acceso a las cuentas de los usuarios, y
             * los logs se copian a sitios con muchos menos controles que la base
             * de datos. Se redactan antes de escribir, no después.
             */
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                'req.body.password',
                'req.body.accessToken',
                'req.body.refreshToken',
              ],
              censor: '[redactado]',
            },

            // El cuerpo NO se registra: en este producto lleva descripciones y
            // comentarios de tickets, que son datos del cliente.
            serializers: {
              req: (req: { id: string; method: string; url: string }) => ({
                id: req.id,
                method: req.method,
                url: req.url,
              }),
              res: (res: { statusCode: number }) => ({
                statusCode: res.statusCode,
              }),
            },

            // Health checks: los ejecuta un orquestador cada pocos segundos y
            // llenarían el log de ruido sin aportar nada.
            autoLogging: {
              ignore: (req: IncomingMessage) =>
                req.url?.startsWith('/health') === true,
            },
          },
        };
      },
    }),
  ],
})
export class LoggerModule {}
