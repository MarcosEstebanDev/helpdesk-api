import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Result, err, ok } from '../../../../shared-kernel';
import type { Env } from '../../../../infrastructure/config/env.schema';
import {
  TriageRejectedError,
  TriageUnavailableError,
} from '../../domain/errors';
import {
  ClassifierOutput,
  TicketClassifier,
} from '../../domain/ports/ticket-classifier';
import { isTicketPriority } from '../../domain/ticket-status';
import {
  isTriageCategory,
  isTriageLanguage,
  isTriageSentiment,
} from '../../domain/triage/ticket-triage.entity';

/**
 * Adapter HTTP hacia `helpdesk-ai` (ADR-0027).
 *
 * Traduce el contrato de errores del servicio a la distinción que le importa a
 * la cola:
 * - red caída, timeout, 429 o 5xx que no sea 502 -> `TriageUnavailableError`
 *   (transitorio: la cola reintenta con backoff).
 * - 4xx o 502 -> `TriageRejectedError` (permanente: a la DLQ). El 502 es el
 *   servicio diciendo "el proveedor rechazó esto de forma definitiva".
 *
 * La respuesta se REVALIDA campo a campo contra los valores del dominio. El
 * servicio de IA ya valida su salida, pero es un sistema externo: lo que entra
 * en NUESTRA base de datos lo decide esta frontera, no la buena fe del otro lado.
 */
@Injectable()
export class HttpTicketClassifier implements TicketClassifier {
  constructor(private readonly config: ConfigService<Env, true>) {}

  async classify(input: {
    subject: string;
    description: string;
  }): Promise<
    Result<ClassifierOutput, TriageUnavailableError | TriageRejectedError>
  > {
    const baseUrl = this.config.get('AI_SERVICE_URL', { infer: true });
    if (baseUrl === undefined) {
      return err(new TriageRejectedError('AI_SERVICE_URL no configurada'));
    }
    const token = this.config.get('AI_SERVICE_TOKEN', { infer: true });
    const timeoutMs = this.config.get('AI_TIMEOUT_MS', { infer: true });

    let response: Response;
    try {
      response = await fetch(new URL('/v1/classify', baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { 'x-internal-token': token }),
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // fetch solo lanza por red o por el AbortSignal: ambos son transitorios.
      const detail = error instanceof Error ? error.message : String(error);
      return err(new TriageUnavailableError(`servicio de IA: ${detail}`));
    }

    if (!response.ok) {
      const detail = `servicio de IA respondió ${response.status}`;
      const transitorio =
        response.status === 429 ||
        (response.status >= 500 && response.status !== 502);
      return err(
        transitorio
          ? new TriageUnavailableError(detail)
          : new TriageRejectedError(detail),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return err(
        new TriageRejectedError('respuesta del servicio de IA no es JSON'),
      );
    }
    return parseClassifyResponse(body);
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const intOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null;

/**
 * Valida la respuesta de `POST /v1/classify`. Exportada para testearla sin red.
 * El contrato de Python usa snake_case; aquí se traduce al camelCase del dominio.
 */
export const parseClassifyResponse = (
  body: unknown,
): Result<ClassifierOutput, TriageRejectedError> => {
  const invalida = (motivo: string) =>
    err(new TriageRejectedError(`respuesta de IA inválida: ${motivo}`));

  if (!isRecord(body)) return invalida('no es un objeto');
  const { classification: c, meta: m } = body;
  if (!isRecord(c) || !isRecord(m)) return invalida('faltan secciones');

  const { category, priority, sentiment, language } = c;
  if (typeof category !== 'string' || !isTriageCategory(category))
    return invalida(`categoría "${String(category)}"`);
  if (typeof priority !== 'string' || !isTicketPriority(priority))
    return invalida(`prioridad "${String(priority)}"`);
  if (typeof sentiment !== 'string' || !isTriageSentiment(sentiment))
    return invalida(`sentimiento "${String(sentiment)}"`);
  if (typeof language !== 'string' || !isTriageLanguage(language))
    return invalida(`idioma "${String(language)}"`);

  const { provider, model, prompt_version, latency_ms } = m;
  if (
    typeof provider !== 'string' ||
    typeof model !== 'string' ||
    typeof prompt_version !== 'string' ||
    typeof latency_ms !== 'number'
  ) {
    return invalida('metadatos incompletos');
  }

  return ok({
    classification: {
      category,
      suggestedPriority: priority,
      sentiment,
      language,
    },
    provenance: {
      // Recortados: son texto de un sistema externo y van a columnas de la BD.
      provider: provider.slice(0, 50),
      model: model.slice(0, 100),
      promptVersion: prompt_version.slice(0, 50),
      latencyMs: Math.max(0, Math.round(latency_ms)),
      inputTokens: intOrNull(m.input_tokens),
      outputTokens: intOrNull(m.output_tokens),
    },
  });
};
