import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

// Forzamos un JWT_SECRET de test conservando el resto de la config real (upload,
// etc. lo leen al importar) para poder montar el router completo.
jest.mock('../../src/config/env', () => {
  const actual = jest.requireActual('../../src/config/env');
  return {
    config: { ...actual.config, jwt: { ...actual.config.jwt, secret: 'test-secret' } },
  };
});
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
// Auto-mock de la BD: ningún handler protegido llega a tocarla en estos tests.
jest.mock('../../src/config/database');

import routes from '../../src/routes';
import { errorHandler, notFoundHandler } from '../../src/middlewares/error.middleware';

const SECRET = 'test-secret';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', routes);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function token(rol: 'admin' | 'user' = 'user'): string {
  return jwt.sign({ sub: 'u1', rol }, SECRET, { expiresIn: '8h' });
}

describe('enforcement global de rutas', () => {
  const app = buildApp();

  describe('rutas públicas (sin token)', () => {
    it('GET /health -> 200 sin token', async () => {
      const res = await request(app).get('/api/v1/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('POST /auth/login -> pasa el enforcement (no 401 de auth)', async () => {
      // Sin credenciales el controller responde 400 (ValidationError): lo relevante
      // es que NO lo bloquea requireAuth (no es 401).
      const res = await request(app).post('/api/v1/auth/login').send({});
      expect(res.status).not.toBe(401);
      expect(res.status).toBe(400);
    });
  });

  describe('rutas protegidas (sin token -> 401)', () => {
    it.each([
      ['get', '/api/v1/jobs'],
      ['get', '/api/v1/stats'],
      ['get', '/api/v1/users'],
      ['get', '/api/v1/auth/me'],
      ['post', '/api/v1/pdf/unlock'],
    ])('%s %s sin token -> 401', async (method, url) => {
      const res = await (request(app) as any)[method](url);
      expect(res.status).toBe(401);
    });
  });

  describe('rutas admin (token de user normal -> 403)', () => {
    it('GET /users con token de user -> 403', async () => {
      const res = await request(app)
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token('user')}`);
      expect(res.status).toBe(403);
    });

    it('POST /certificates con token de user -> 403', async () => {
      const res = await request(app)
        .post('/api/v1/certificates')
        .set('Authorization', `Bearer ${token('user')}`)
        .send({ nombre: 'X' });
      expect(res.status).toBe(403);
    });
  });
});
