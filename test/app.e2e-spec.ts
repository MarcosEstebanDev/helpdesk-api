import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health returns ok', async () => {
    const response = await request(app.getHttpServer())
      .get('/health')
      .expect(200);

    const body = response.body as { status: string; timestamp: string };
    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body.timestamp).toBe('string');
  });
});
