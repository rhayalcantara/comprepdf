import { Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';

// Config/logger/DB mockeados: los controllers no tocan la BD real (se espía el modelo).
jest.mock('../../src/config/env', () => ({
  config: { jwt: { secret: 'test-secret', expiresIn: '8h' }, adminInitialPassword: '' },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/config/database', () => ({
  AppDataSource: { getRepository: jest.fn() },
}));

import { listUsers, createUser, updateUser } from '../../src/controllers/user.controller';
import { UserModel, User } from '../../src/models/user.model';
import { ValidationError, NotFoundError } from '../../src/utils/errors';

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

describe('user.controller', () => {
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  const nextError = () => (mockNext as jest.Mock).mock.calls[0]?.[0];
  const payload = () => jsonMock.mock.calls[0][0];

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    mockResponse = { json: jsonMock, status: statusMock };
    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  describe('listUsers', () => {
    it('devuelve SafeUser[] sin passwordHash, con paginación y pendingTotal', async () => {
      const listPage = jest.spyOn(UserModel, 'listPage').mockResolvedValue({
        users: [fakeUser(), fakeUser({ id: 'user-2', username: 'aroe' })],
        total: 2,
        pendingTotal: 1,
      });

      await listUsers({ query: {} } as unknown as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(listPage).toHaveBeenCalledWith({
        page: 1, limit: 10, rol: undefined, estado: undefined, q: undefined,
      });
      const data = payload().data;
      expect(data.users).toHaveLength(2);
      expect(data.users[0].passwordHash).toBeUndefined();
      expect(data.users[0].username).toBe('jdoe');
      expect(data.pagination).toEqual({ page: 1, limit: 10, total: 2, totalPages: 1 });
      expect(data.pendingTotal).toBe(1);
    });

    it('pasa página, límite y filtros válidos al modelo', async () => {
      const listPage = jest.spyOn(UserModel, 'listPage').mockResolvedValue({
        users: [], total: 0, pendingTotal: 0,
      });

      await listUsers(
        { query: { page: '3', limit: '25', rol: 'admin', estado: 'pendiente', q: '  pérez  ' } } as unknown as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(listPage).toHaveBeenCalledWith({
        page: 3, limit: 25, rol: 'admin', estado: 'pendiente', q: 'pérez',
      });
    });

    it('rechaza un filtro fuera de la whitelist con 400', async () => {
      const listPage = jest.spyOn(UserModel, 'listPage');

      await listUsers(
        { query: { rol: 'superadmin' } } as unknown as Request,
        mockResponse as Response,
        mockNext,
      );

      expect(listPage).not.toHaveBeenCalled();
      expect(nextError()).toBeInstanceOf(ValidationError);
    });
  });

  describe('createUser', () => {
    it('genera contraseña temporal, hashea (cost 12), fuerza must_change_password y la devuelve una vez', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);
      const hashSpy = jest
        .spyOn(bcrypt, 'hash')
        .mockResolvedValue('$2a$12$newhash' as never);
      const createSpy = jest
        .spyOn(UserModel, 'create')
        .mockImplementation(async (input) => fakeUser({ ...input, id: 'new-1' } as Partial<User>));

      const req = { body: { username: 'nuevo', nombre: 'Nuevo User', rol: 'user' } } as Request;
      await createUser(req, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);

      // bcrypt con cost 12
      expect(hashSpy.mock.calls[0][1]).toBe(12);

      const createArg = createSpy.mock.calls[0][0];
      expect(createArg.mustChangePassword).toBe(true);
      expect(createArg.passwordHash).toBe('$2a$12$newhash');

      const data = payload().data;
      expect(typeof data.temporaryPassword).toBe('string');
      expect(data.temporaryPassword.length).toBeGreaterThan(0);
      expect(data.user.passwordHash).toBeUndefined();
    });

    it('con password provista por el admin: NO devuelve temporaryPassword', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(null);
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('$2a$12$newhash' as never);
      jest
        .spyOn(UserModel, 'create')
        .mockImplementation(async (input) => fakeUser({ ...input, id: 'new-1' } as Partial<User>));

      const req = {
        body: { username: 'nuevo', nombre: 'Nuevo', password: 'admin-set-pass' },
      } as Request;
      await createUser(req, mockResponse as Response, mockNext);

      expect(payload().data.temporaryPassword).toBeUndefined();
    });

    it('username duplicado -> 400', async () => {
      jest.spyOn(UserModel, 'findByUsername').mockResolvedValue(fakeUser());
      const createSpy = jest.spyOn(UserModel, 'create');

      const req = { body: { username: 'jdoe', nombre: 'Dup' } } as Request;
      await createUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeInstanceOf(ValidationError);
      expect(nextError().message).toBe('username already exists');
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('rol inválido -> 400', async () => {
      const req = { body: { username: 'x', nombre: 'X', rol: 'superadmin' } } as Request;
      await createUser(req, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(ValidationError);
    });

    it('falta username -> 400', async () => {
      const req = { body: { nombre: 'X' } } as Request;
      await createUser(req, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(ValidationError);
    });
  });

  describe('updateUser', () => {
    it('reset de contraseña: hashea y fuerza must_change_password=true', async () => {
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('$2a$12$reset' as never);
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(fakeUser({ id: 'user-2', mustChangePassword: true }));

      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { newPassword: 'brand-new-pass' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalledWith('user-2', {
        passwordHash: '$2a$12$reset',
        mustChangePassword: true,
      });
      expect(payload().data.user.passwordHash).toBeUndefined();
    });

    it('cambia rol y estado de OTRO usuario (admin)', async () => {
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(fakeUser({ id: 'user-2', rol: 'admin', estado: 'inactivo' }));

      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { rol: 'admin', estado: 'inactivo' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(updateSpy).toHaveBeenCalledWith('user-2', { rol: 'admin', estado: 'inactivo' });
    });

    it('activa un usuario pendiente (estado="activo") -> 200', async () => {
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(fakeUser({ id: 'user-2', estado: 'activo' }));

      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { estado: 'activo' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeUndefined();
      expect(updateSpy).toHaveBeenCalledWith('user-2', { estado: 'activo' });
      expect(payload().data.user.estado).toBe('activo');
    });

    it('acepta estado="pendiente" como válido', async () => {
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(fakeUser({ id: 'user-2', estado: 'pendiente' }));

      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { estado: 'pendiente' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeUndefined();
      expect(updateSpy).toHaveBeenCalledWith('user-2', { estado: 'pendiente' });
    });

    it('anti-lockout: el admin NO puede cambiar su propio rol -> 400 y no actualiza', async () => {
      const updateSpy = jest.spyOn(UserModel, 'update');
      const req = {
        params: { id: 'admin-9' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { rol: 'user' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeInstanceOf(ValidationError);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('anti-lockout: el admin NO puede cambiar su propio estado -> 400', async () => {
      const req = {
        params: { id: 'admin-9' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { estado: 'inactivo' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(ValidationError);
    });

    it('el admin SÍ puede resetear su propia contraseña', async () => {
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('$2a$12$own' as never);
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(fakeUser({ id: 'admin-9' }));

      const req = {
        params: { id: 'admin-9' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { newPassword: 'my-new-pass' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeUndefined();
      expect(updateSpy).toHaveBeenCalled();
    });

    it('usuario inexistente -> 404', async () => {
      jest.spyOn(UserModel, 'update').mockResolvedValue(null);
      const req = {
        params: { id: 'ghost' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { estado: 'inactivo' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(NotFoundError);
    });

    it('estado inválido -> 400', async () => {
      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { estado: 'suspendido' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(ValidationError);
    });

    it('edita nombre y correo de otro usuario -> update con {nombre, email}', async () => {
      jest.spyOn(UserModel, 'findByEmail').mockResolvedValue(null);
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(
          fakeUser({ id: 'user-2', nombre: 'Nuevo Nombre', email: 'nuevo@coopaspire.com.do' }),
        );

      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { nombre: 'Nuevo Nombre', email: 'nuevo@coopaspire.com.do' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeUndefined();
      expect(updateSpy).toHaveBeenCalledWith('user-2', {
        nombre: 'Nuevo Nombre',
        email: 'nuevo@coopaspire.com.do',
      });
    });

    it('rechaza editar a un correo ya usado por OTRO usuario -> 400 y no actualiza', async () => {
      jest
        .spyOn(UserModel, 'findByEmail')
        .mockResolvedValue(fakeUser({ id: 'otro-7', email: 'taken@coopaspire.com.do' }));
      const updateSpy = jest.spyOn(UserModel, 'update');

      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { email: 'taken@coopaspire.com.do' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeInstanceOf(ValidationError);
      expect(updateSpy).not.toHaveBeenCalled();
    });

    it('conservar el mismo correo (mismo id) no es conflicto', async () => {
      jest
        .spyOn(UserModel, 'findByEmail')
        .mockResolvedValue(fakeUser({ id: 'user-2', email: 'mismo@coopaspire.com.do' }));
      const updateSpy = jest
        .spyOn(UserModel, 'update')
        .mockResolvedValue(fakeUser({ id: 'user-2', email: 'mismo@coopaspire.com.do' }));

      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: { email: 'mismo@coopaspire.com.do', nombre: 'X' },
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);

      expect(nextError()).toBeUndefined();
      expect(updateSpy).toHaveBeenCalled();
    });

    it('sin campos a actualizar -> 400', async () => {
      const req = {
        params: { id: 'user-2' },
        user: { id: 'admin-9', rol: 'admin' },
        body: {},
      } as unknown as Request;
      await updateUser(req, mockResponse as Response, mockNext);
      expect(nextError()).toBeInstanceOf(ValidationError);
    });
  });
});
