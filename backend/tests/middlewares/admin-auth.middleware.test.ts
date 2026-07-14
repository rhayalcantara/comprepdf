import { Request, Response, NextFunction } from 'express';

// Config mockeada y mutable: cada test ajusta `config.adminKey`.
jest.mock('../../src/config/env', () => ({
  config: { adminKey: '' },
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { requireAdminKey } from '../../src/middlewares/admin-auth.middleware';
import { config } from '../../src/config/env';

describe('requireAdminKey middleware', () => {
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

    config.adminKey = 'super-secret-key';
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('llama a next() cuando la clave es correcta', () => {
    getMock.mockReturnValue('super-secret-key');

    requireAdminKey(mockRequest as Request, mockResponse as Response, mockNext);

    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('responde 401 cuando falta el header X-Admin-Key', () => {
    getMock.mockReturnValue(undefined);

    requireAdminKey(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('responde 401 cuando la clave es incorrecta', () => {
    getMock.mockReturnValue('wrong-key');

    requireAdminKey(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('falla cerrado con 503 cuando CERT_ADMIN_KEY no está configurada', () => {
    config.adminKey = '';
    getMock.mockReturnValue('cualquier-cosa');

    requireAdminKey(mockRequest as Request, mockResponse as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(503);
    expect(mockNext).not.toHaveBeenCalled();
  });
});
