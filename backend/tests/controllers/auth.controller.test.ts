import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';

// Config mockeada y mutable (JWT secret / expiración controlados por test).
jest.mock('../../src/config/env', () => ({
  config: {
    jwt: { secret: 'test-secret', expiresIn: '8h' },
    adminInitialPassword: '',
    allowedSignupDomain: 'coopaspire.com.do',
  },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
// Evita tocar la BD real: el modelo se importa pero sus métodos se espían.
jest.mock('../../src/config/database', () => ({
  AppDataSource: { getRepository: jest.fn() },
}));

import { login, register, changePassword } from '../../src/controllers/auth.controller';
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
      jest.spyOn(UserModel, 'findByEmail').mockResolvedValue(null);

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

    it('usuario pendiente -> 403 con mensaje de activación (tras validar la contraseña)', async () => {
      jest
        .spyOn(UserModel, 'findByUsername')
        .mockResolvedValue(fakeUser({ estado: 'pendiente' }));
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

      mockRequest = { body: { username: 'jdoe', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.statusCode).toBe(403);
      expect(err.message).toBe(
        'Tu cuenta está pendiente de activación por un administrador.',
      );
    });

    it('usuario inactivo -> 403 con mensaje de cuenta inactiva', async () => {
      jest
        .spyOn(UserModel, 'findByUsername')
        .mockResolvedValue(fakeUser({ estado: 'inactivo' }));
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);

      mockRequest = { body: { username: 'jdoe', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(ForbiddenError);
      expect(err.message).toBe('Tu cuenta está inactiva.');
    });

    it('entra con el CORREO cuando el username no casa', async () => {
      // El caso real de QA: la cuenta se dio de alta con un username que su
      // dueño no acierta a teclear, pero su correo sí lo sabe.
      const user = fakeUser({ username: 'michael ferreras', email: 'mferreras@coop.do' });
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);
      const byEmail = jest.spyOn(UserModel, 'findByEmail').mockResolvedValue(user);
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      jest.spyOn(UserModel, 'updateLastLogin').mockResolvedValue(undefined);

      mockRequest = { body: { username: 'mferreras@coop.do', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(byEmail).toHaveBeenCalledWith('mferreras@coop.do');
      expect(jsonMock.mock.calls[0][0].data.user.username).toBe('michael ferreras');
    });

    it('el username manda: si casa, NO se consulta por correo', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(fakeUser());
      const byEmail = jest.spyOn(UserModel, 'findByEmail');
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      jest.spyOn(UserModel, 'updateLastLogin').mockResolvedValue(undefined);

      mockRequest = { body: { username: 'jdoe', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      expect(byEmail).not.toHaveBeenCalled();
    });

    it('recorta los espacios del identificador antes de buscar', async () => {
      const byUsername = jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(fakeUser());
      jest.spyOn(bcrypt, 'compare').mockResolvedValue(true as never);
      jest.spyOn(UserModel, 'updateLastLogin').mockResolvedValue(undefined);

      mockRequest = { body: { username: '  jdoe  ', password: 'good-pass' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      expect(byUsername).toHaveBeenCalledWith('jdoe');
    });

    it('correo que no existe -> 401 con el mismo mensaje genérico', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);
      jest.spyOn(UserModel, 'findByEmail').mockResolvedValue(null);

      mockRequest = { body: { username: 'nadie@coop.do', password: 'x' } };

      await login(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect(err.message).toBe('Invalid credentials');
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

  describe('register', () => {
    const validBody = {
      username: 'nuevo',
      nombre: 'Nuevo Usuario',
      email: 'nuevo@coopaspire.com.do',
      password: 'una-clave-segura',
    };

    it('caso feliz: crea usuario pendiente (rol user, sin token) y responde 201', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);
      jest.spyOn(UserModel, 'findByEmail').mockResolvedValue(null);
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('$2a$12$newhash' as never);
      const createSpy = jest
        .spyOn(UserModel, 'create')
        .mockImplementation(async (input) => fakeUser({ ...input, id: 'new-1' } as Partial<User>));

      mockRequest = { body: { ...validBody } };

      await register(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);

      const createArg = createSpy.mock.calls[0][0];
      expect(createArg.estado).toBe('pendiente');
      expect(createArg.rol).toBe('user');
      expect(createArg.mustChangePassword).toBe(false);
      expect(createArg.authProvider).toBe('local');
      expect(createArg.email).toBe('nuevo@coopaspire.com.do');
      // bcrypt cost 12
      expect((bcrypt.hash as unknown as jest.Mock).mock.calls[0][1]).toBe(12);

      const data = jsonMock.mock.calls[0][0].data;
      expect(data.message).toBe(
        'Cuenta creada. Un administrador debe activarla antes de que puedas iniciar sesión.',
      );
      // No auto-login: nunca devuelve token ni el usuario.
      expect(data.token).toBeUndefined();
      expect(data.user).toBeUndefined();
    });

    it('normaliza el email a minúsculas antes de guardarlo y comprobar unicidad', async () => {
      const findByEmail = jest.spyOn(UserModel, 'findByEmail').mockResolvedValue(null);
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('$2a$12$newhash' as never);
      const createSpy = jest
        .spyOn(UserModel, 'create')
        .mockImplementation(async (input) => fakeUser({ ...input, id: 'new-1' } as Partial<User>));

      mockRequest = { body: { ...validBody, email: 'Nuevo@CoopAspire.com.do' } };

      await register(mockRequest as Request, mockResponse as Response, mockNext);

      expect(findByEmail).toHaveBeenCalledWith('nuevo@coopaspire.com.do');
      expect(createSpy.mock.calls[0][0].email).toBe('nuevo@coopaspire.com.do');
    });

    it('dominio no permitido -> 400 con mensaje claro', async () => {
      const createSpy = jest.spyOn(UserModel, 'create');
      mockRequest = { body: { ...validBody, email: 'nuevo@gmail.com' } };

      await register(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe('El correo debe pertenecer al dominio coopaspire.com.do');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('contraseña demasiado corta -> 400', async () => {
      mockRequest = { body: { ...validBody, password: 'corta' } };
      await register(mockRequest as Request, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(ValidationError);
    });

    it('username duplicado -> 400 "El usuario ya existe"', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(fakeUser());
      const createSpy = jest.spyOn(UserModel, 'create');

      mockRequest = { body: { ...validBody } };
      await register(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe('El usuario ya existe');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('email duplicado -> 400 "El correo ya está registrado"', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);
      jest.spyOn(UserModel, 'findByEmail').mockResolvedValue(fakeUser({ id: 'other' }));
      const createSpy = jest.spyOn(UserModel, 'create');

      mockRequest = { body: { ...validBody } };
      await register(mockRequest as Request, mockResponse as Response, mockNext);

      const err = nextError();
      expect(err).toBeInstanceOf(ValidationError);
      expect(err.message).toBe('El correo ya está registrado');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('faltan campos obligatorios -> 400', async () => {
      mockRequest = { body: { username: 'x' } };
      await register(mockRequest as Request, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(ValidationError);
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
