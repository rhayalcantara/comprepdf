import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/config/database');
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { issueCertificate } from '../../src/controllers/certificate.controller';
import { AppDataSource } from '../../src/config/database';

describe('issueCertificate — auditoría del emisor', () => {
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let jobRepo: { create: jest.Mock; save: jest.Mock };

  const savedJob = () => jobRepo.save.mock.calls[0][0];

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    mockResponse = { json: jsonMock, status: statusMock };
    mockNext = jest.fn();

    jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    (AppDataSource.getRepository as jest.Mock).mockReturnValue(jobRepo);
  });

  afterEach(() => jest.clearAllMocks());

  it('guarda user_id del admin en el job y emitido_por_user_id en los params', async () => {
    const req = {
      body: { nombre: 'Ana', pfxPassword: 'secret', validityYears: '2' },
      user: { id: 'admin-9', rol: 'admin' },
    } as unknown as Request;

    await issueCertificate(req, mockResponse as Response, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(201);

    const job = savedJob();
    expect(job.userId).toBe('admin-9');
    expect(job.operationType).toBe('certificate');
    expect(job.operationParams).toEqual(
      expect.objectContaining({
        nombre: 'Ana',
        emitido_por_user_id: 'admin-9',
        validity_years: 2,
      }),
    );
  });
});
