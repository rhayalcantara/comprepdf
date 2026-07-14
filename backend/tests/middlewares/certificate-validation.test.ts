import { Request, Response, NextFunction } from 'express';
import { validateCertificateRequest } from '../../src/middlewares/validation.middleware';

describe('validateCertificateRequest', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    req = { body: {} };
    res = { json: jsonMock, status: statusMock };
    next = jest.fn();
  });

  afterEach(() => jest.clearAllMocks());

  it('acepta un payload válido con email', () => {
    req.body = {
      nombre: 'Juan Pérez',
      email: 'jperez@coopaspire.com.do',
      departamento: 'TI',
      pfxPassword: 'secreta123',
    };
    validateCertificateRequest(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(statusMock).not.toHaveBeenCalled();
  });

  it('acepta cédula sin email', () => {
    req.body = { nombre: 'Ana', cedula: '001-1234567-8', pfxPassword: 'secreta123' };
    validateCertificateRequest(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('rechaza si falta nombre', () => {
    req.body = { email: 'x@y.com', pfxPassword: 'secreta123' };
    validateCertificateRequest(req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza si no hay ni cédula ni email', () => {
    req.body = { nombre: 'Juan', pfxPassword: 'secreta123' };
    validateCertificateRequest(req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza contraseña de .pfx demasiado corta', () => {
    req.body = { nombre: 'Juan', email: 'j@y.com', pfxPassword: '123' };
    validateCertificateRequest(req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza email con formato inválido', () => {
    req.body = { nombre: 'Juan', email: 'no-es-email', pfxPassword: 'secreta123' };
    validateCertificateRequest(req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('rechaza validityYears fuera de rango', () => {
    req.body = { nombre: 'Juan', email: 'j@y.com', pfxPassword: 'secreta123', validityYears: 10 };
    validateCertificateRequest(req as Request, res as Response, next);
    expect(statusMock).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });
});
