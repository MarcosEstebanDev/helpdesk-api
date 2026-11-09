import { ConfigService } from '@nestjs/config';
import type { Env } from '../../../../infrastructure/config/env.schema';
import {
  TriageRejectedError,
  TriageUnavailableError,
} from '../../domain/errors';
import {
  HttpTicketClassifier,
  parseClassifyResponse,
} from './http-ticket-classifier';

const RESPUESTA_OK = {
  classification: {
    category: 'billing',
    priority: 'HIGH',
    sentiment: 'negative',
    language: 'es',
  },
  meta: {
    provider: 'ollama',
    model: 'qwen2.5:3b-instruct',
    prompt_version: 'triage-v1',
    latency_ms: 2965.4,
    input_tokens: 402,
    output_tokens: 31,
    attempts: 1,
  },
};

const configCon = (valores: Partial<Env>) =>
  ({
    get: (clave: keyof Env) =>
      (({ AI_TIMEOUT_MS: 1000, ...valores }) as Partial<Env>)[clave],
  }) as unknown as ConfigService<Env, true>;

const TICKET = {
  subject: 'Cobro doble',
  description: 'Me cobraron dos veces.',
};

describe('parseClassifyResponse', () => {
  it('traduce el contrato snake_case de Python al dominio', () => {
    const result = parseClassifyResponse(RESPUESTA_OK);

    expect(result.isOk() && result.value).toEqual({
      classification: {
        category: 'billing',
        suggestedPriority: 'HIGH',
        sentiment: 'negative',
        language: 'es',
      },
      provenance: {
        provider: 'ollama',
        model: 'qwen2.5:3b-instruct',
        promptVersion: 'triage-v1',
        latencyMs: 2965,
        inputTokens: 402,
        outputTokens: 31,
      },
    });
  });

  it.each([
    ['una categoría que el dominio no conoce', { category: 'refunds' }],
    ['una prioridad fuera del enum', { priority: 'CRITICAL' }],
    ['un sentimiento desconocido', { sentiment: 'furious' }],
  ])('rechaza %s', (_caso, cambio) => {
    const body = {
      ...RESPUESTA_OK,
      classification: { ...RESPUESTA_OK.classification, ...cambio },
    };

    const result = parseClassifyResponse(body);

    expect(result.isErr() && result.error).toBeInstanceOf(TriageRejectedError);
  });

  it('tokens ausentes o raros quedan como null en vez de romper', () => {
    const body = {
      ...RESPUESTA_OK,
      meta: { ...RESPUESTA_OK.meta, input_tokens: null, output_tokens: -3 },
    };

    const result = parseClassifyResponse(body);

    expect(result.isOk() && result.value.provenance.inputTokens).toBeNull();
    expect(result.isOk() && result.value.provenance.outputTokens).toBeNull();
  });
});

describe('HttpTicketClassifier', () => {
  const fetchOriginal = global.fetch;
  afterEach(() => {
    global.fetch = fetchOriginal;
  });

  const responderCon = (status: number, body: unknown = RESPUESTA_OK) => {
    const espia = jest
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(body), { status }));
    global.fetch = espia;
    return espia;
  };

  it('manda solo asunto y descripción, con el token interno', async () => {
    const espia = responderCon(200);
    const sut = new HttpTicketClassifier(
      configCon({
        AI_SERVICE_URL: 'http://ai:8000',
        AI_SERVICE_TOKEN: 'secreto-de-16-chars',
      }),
    );

    const result = await sut.classify(TICKET);

    expect(result.isOk()).toBe(true);
    const [url, init] = espia.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://ai:8000/v1/classify');
    expect(JSON.parse(init.body as string)).toEqual(TICKET);
    expect(init.headers).toMatchObject({
      'x-internal-token': 'secreto-de-16-chars',
    });
  });

  it.each([
    [503, TriageUnavailableError],
    [500, TriageUnavailableError],
    [429, TriageUnavailableError],
    [502, TriageRejectedError],
    [422, TriageRejectedError],
    [401, TriageRejectedError],
  ])('un %i se traduce a %p', async (status, tipo) => {
    responderCon(status, { detail: 'x' });
    const sut = new HttpTicketClassifier(
      configCon({ AI_SERVICE_URL: 'http://ai:8000' }),
    );

    const result = await sut.classify(TICKET);

    expect(result.isErr() && result.error).toBeInstanceOf(tipo);
  });

  it('un fallo de red es transitorio', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const sut = new HttpTicketClassifier(
      configCon({ AI_SERVICE_URL: 'http://ai:8000' }),
    );

    const result = await sut.classify(TICKET);

    expect(result.isErr() && result.error).toBeInstanceOf(
      TriageUnavailableError,
    );
  });
});
