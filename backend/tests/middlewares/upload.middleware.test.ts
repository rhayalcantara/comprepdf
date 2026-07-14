import { Request, Response, NextFunction } from 'express';

jest.mock('fs/promises', () => ({
  unlink: jest.fn(),
}));

import fs from 'fs/promises';
import { enforceSignatureSizeLimit, SIGNATURE_MAX_SIZE_MB } from '../../src/middlewares/upload.middleware';
import { ValidationError } from '../../src/utils/errors';

function mockFile(field: string, size: number): Express.Multer.File {
  return {
    fieldname: field,
    originalname: `${field}.bin`,
    filename: `stored-${field}`,
    path: `uploads/stored-${field}`,
    size,
    mimetype: 'application/octet-stream',
  } as Express.Multer.File;
}

describe('enforceSignatureSizeLimit middleware', () => {
  let mockRequest: Partial<Request>;
  let mockNext: NextFunction;

  beforeEach(() => {
    mockNext = jest.fn();
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  async function run(files?: { [field: string]: Express.Multer.File[] }): Promise<void> {
    mockRequest = { files: files as Request['files'] };
    await enforceSignatureSizeLimit(mockRequest as Request, {} as Response, mockNext);
  }

  it('deja pasar una firma dentro del límite', async () => {
    await run({
      file: [mockFile('file', 10 * 1024 * 1024)],
      signature: [mockFile('signature', SIGNATURE_MAX_SIZE_MB * 1024 * 1024)],
    });

    expect(mockNext).toHaveBeenCalledWith();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('deja pasar requests sin firma (modo certificate)', async () => {
    await run({ file: [mockFile('file', 1024)], cert: [mockFile('cert', 1024)] });
    expect(mockNext).toHaveBeenCalledWith();
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('deja pasar requests sin archivos', async () => {
    await run(undefined);
    expect(mockNext).toHaveBeenCalledWith();
  });

  it('rechaza con 400 una firma que excede 2MB y borra TODOS los archivos', async () => {
    const pdf = mockFile('file', 1024);
    const cert = mockFile('cert', 1024);
    const signature = mockFile('signature', SIGNATURE_MAX_SIZE_MB * 1024 * 1024 + 1);

    await run({ file: [pdf], cert: [cert], signature: [signature] });

    expect(mockNext).toHaveBeenCalledTimes(1);
    const error = (mockNext as jest.Mock).mock.calls[0][0];
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain(`Signature image exceeds ${SIGNATURE_MAX_SIZE_MB}MB limit`);
    expect(fs.unlink).toHaveBeenCalledWith(pdf.path);
    expect(fs.unlink).toHaveBeenCalledWith(cert.path);
    expect(fs.unlink).toHaveBeenCalledWith(signature.path);
  });
});
