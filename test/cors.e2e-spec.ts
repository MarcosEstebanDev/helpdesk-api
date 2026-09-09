import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';

const ORIGEN_PERMITIDO = 'http://localhost:3001';

/**
 * CORS con credenciales.
 *
 * Esta suite existe por un fallo real: `enableCors()` sin opciones devolvía
 * `Access-Control-Allow-Origin: *` y ninguna cabecera de credenciales. El
 * frontend manda `credentials: 'include'` para que viaje la cookie httpOnly del
 * refresh, y ante esa combinación el navegador DESCARTA la respuesta entera. O
 * sea: la API funcionaba para curl y para los 99 e2e, y no funcionaba para el
 * único cliente que tiene.
 *
 * No lo detectó ningún test porque **supertest no aplica la política de CORS**:
 * habla con el servidor directamente, sin navegador que haga cumplir nada. Lo
 * que sí se puede comprobar —y es lo que hace esto— es que el servidor emita las
 * cabeceras correctas.
 */
describe('CORS (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('responde al preflight con el origen EXACTO y credenciales', async () => {
    const res = await request(app.getHttpServer())
      .options('/auth/refresh')
      .set('Origin', ORIGEN_PERMITIDO)
      .set('Access-Control-Request-Method', 'POST')
      .expect(204);

    // El origen exacto, NUNCA `*`: con credenciales el comodín invalida la
    // respuesta en el navegador.
    expect(res.headers['access-control-allow-origin']).toBe(ORIGEN_PERMITIDO);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('nunca devuelve el comodín', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', ORIGEN_PERMITIDO)
      .expect(200);

    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });

  it('no autoriza a un origen que no está en la lista', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'http://evil.example')
      .expect(200);

    // Sin `Access-Control-Allow-Origin` el navegador bloquea la lectura de la
    // respuesta. La petición se sirve igual: CORS protege al usuario del sitio
    // malicioso, no al servidor.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
