import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';

// Config mockeada y mutable (JWT secret / expiración controlados por test).
jest.mock('../../src/config/env', () => ({
  config: {
    jwt: { secret: 'test-secret', expiresIn: '8h' },
    adminInitialPassword: '',
  },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
// Evita tocar la BD real: el modelo se importa pero sus métodos se espían.
jest.mock('../../src/config/database', () => ({
  AppDataSource: { getRepository: jest.fn() },
}));

import { login, changePassword } from '../../src/controllers/auth.controller';
import { config } from '../../src/config/env';
import { UserModel, User } from '../../src/models/user.model';
import {
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
} from '../../src/utils/errors';

function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    username: 'jdoe',
    email: 'jdoe@coop.do',
    nombre: 'John Doe',
    passwordHash: '$2a$12$hash',
    rol: 'user',
    estado: 'activo',
    authProvider: 'local',
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  } as User;
}

describe('auth.controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    mockResponse = { json: jsonMock, status: statusMock };
    mockNext = jest.fn();

    config.jwt.secret = 'test-secret';
    config.jwt.expiresIn = '8h';
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  const nextError = () => (mockNext as jest.Mock).mock.calls[0][0];

  describe('login', () => {
    it('caso feliz: devuelve token y user sin passwordHash, actualiza last_login', async () => {
      const user = fakeUser();
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(user);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      const updateSpy = jest
        .spyOn(UserModel, 'updateLastLogin')
        .mockResolvedValue(undefined);

      mockRequest = { body: { username: 'jdoe', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith('user-1');

      const payload = jsonMock.mock.calls[0][0];
      expect(payload.success).toBe(true);
      expect(typeof payload.data.token).toBe('string');
      expect(payload.data.token.split('.')).toHaveLength(3); // JWT
      expect(payload.data.user.id).toBe('user-1');
      // Nunca se filtra el hash
      expect(payload.data.user.passwordHash).toBeUndefined();
    });

    it('contraseña incorrecta -> 401 Invalid credentials', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(fakeUser());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);

      mockRequest = { body: { username: 'jdoe', password: 'bad' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(err.statusCode).toBe(401);
      expect(err.message).toBe('Invalid credentials');
    });

    it('usuario inexistente -> 401 Invalid credentials (mismo mensaje)', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);

      mockRequest = { body: { username: 'ghost', password: 'x' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(err.message).toBe('Invalid credentials');
    });

    it('usuario inactivo -> 403 (solo tras validar la contraseña)', async () => {
      jest
        .spyOn(UserModel, 'findByUsername')
        .mockResolvedValue(fakeUser({ estado: 'inactivo' }));
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

      mockRequest = { body: { username: 'jdoe', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.statusCode).toBe(403);
    });

    it('faltan credenciales -> 400 ValidationError', async () => {
      mockRequest = { body: { username: 'jdoe' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      expect(nextError()).toBeInstanceOf(ValidationError);
    });

    it('sin JWT_SECRET -> 503 (fail-closed) y no consulta la BD', async () => {
      config.jwt.secret = '';
      const findSpy = jest.spyOn(UserModel, 'findByUsername');

      mockRequest = { body: { username: 'jdoe', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(503);
      expect(findSpy).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    it('caso feliz: valida actual, guarda nueva y limpia must_change_password', async () => {
      const user = fakeUser({ mustChangePassword: true });
      jest.spyOn(UserModel, 'findById').mockResolvedValue(user);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('$2a$12$newhash' as never);
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(fakeUser({ mustChangePassword: false }));

      mockRequest = {
        user: { id: 'user-1', rol: 'user' },
        body: { currentPassword: 'old-pass', newPassword: 'new-pass-123' },
      };

      await changePassword(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith('user-1', {
        passwordHash: '$2a$12$newhash',
        mustChangePassword: false,
      });
      expect(jsonMock.mock.calls[0][0].success).toBe(true);
    });

    it('contraseña actual incorrecta -> 401 y no actualiza', async () => {
      jest.spyOn(UserModel, 'findById').mockResolvedValue(fakeUser());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(false as never);
      const updateSpy = jest.spyOn(UserModel, 'update');

      mockRequest = {
        user: { id: 'user-1', rol: 'user' },
        body: { currentPassword: 'wrong', newPassword: 'new-pass-123' },
      };

      await changePassword(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(err.message).toBe('Current password is incorrect');
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('nueva contraseña demasiado corta -> 400', async () => {
      mockRequest = {
        user: { id: 'user-1', rol: 'user' },
        body: { currentPassword: 'old-pass', newPassword: 'short' },
      };

      await changePassword(mockRequest as Request, mockResponse as Response, mockNext);

      expect(nextError()).toBeInstanceOf(ValidationError);
    });
  });
});
