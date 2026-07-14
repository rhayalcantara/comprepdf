import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Config mockeada y mutable: cada test ajusta `config.jwt.secret`.
jest.mock('../../src/config/env', () => ({
  config: { jwt: { secret: 'test-secret', expiresIn: '8h' } },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { requireAuth, requireRole } from '../../src/middlewares/auth.middleware';
import { config } from '../../src/config/env';

const SECRET = 'test-secret';

function sign(payload: object, options?: jwt.SignOptions): string {
  return jwt.sign(payload, SECRET, options);
}

describe('requireAuth middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let getMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    getMock = jest.fn();

    mockRequest = { get: getMock as unknown as Request['get'] };
    mockResponse = { json: jsonMock, status: statusMock };
    mockNext = jest.fn();

    config.jwt.secret = SECRET;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('llama a next() y carga req.user con un token válido', () => {
    const token = sign({ sub: 'user-1', rol: 'user' });
    getMock.mockReturnValue(`Bearer ${token}`);

    requireAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
    expect(mockRequest.user).toEqual({ id: 'user-1', rol: 'user' });
  });

  it('responde 401 con un token expirado', () => {
    const token = sign({ sub: 'user-1', rol: 'user' }, { expiresIn: -1 });
    getMock.mockReturnValue(`Bearer ${token}`);

    requireAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRequest.user).toBeUndefined();
  });

  it('responde 401 con un token inválido (firma incorrecta)', () => {
    const token = jwt.sign({ sub: 'user-1', rol: 'user' }, 'otro-secreto');
    getMock.mockReturnValue(`Bearer ${token}`);

    requireAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('responde 401 cuando falta el header Authorization', () => {
    getMock.mockReturnValue(undefined);

    requireAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('responde 401 cuando el header no usa el esquema Bearer', () => {
    getMock.mockReturnValue('Basic abc123');

    requireAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('falla cerrado con 503 cuando JWT_SECRET no está configurada', () => {
    config.jwt.secret = '';
    getMock.mockReturnValue('Bearer cualquier-cosa');

    requireAuth(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(503);
    expect(mockNext).not.toHaveBeenCalled();
  });
});

describe('requireRole middleware', () => {
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    mockResponse = { json: jsonMock, status: statusMock };
    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('llama a next() cuando el rol coincide (admin)', () => {
    const req = { user: { id: 'u1', rol: 'admin' as const } } as Request;

    requireRole('admin')(req, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('responde 403 cuando el rol no coincide (user pidiendo admin)', () => {
    const req = { user: { id: 'u1', rol: 'user' as const } } as Request;

    requireRole('admin')(req, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('responde 401 cuando no hay usuario autenticado', () => {
    const req = {} as Request;

    requireRole('admin')(req, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
