import { Request, Response, NextFunction } from 'express';
import path from 'path';

jest.mock('../../src/config/database');
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  unlink: jest.fn(),
}));

import fs from 'fs/promises';
import { signPdf, editPdf } from '../../src/controllers/pdf-operation.controller';
import { AppDataSource } from '../../src/config/database';
import { CompressionJob } from '../../src/models/job.model';
import { ValidationError } from '../../src/utils/errors';

const PDF_BUFFER = Buffer.from('%PDF-1.7\nfake pdf content');
const PNG_BUFFER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BUFFER = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const TEXT_BUFFER = Buffer.from('no soy una imagen');

/** Crea un Express.Multer.File mínimo como los que produce multer.fields(). */
function mockFile(field: string, originalname: string, mimetype: string): Express.Multer.File {
  return {
    fieldname: field,
    originalname,
    filename: `stored-${field}`,
    path: `uploads/stored-${field}`,
    size: 1024,
    mimetype,
  } as Express.Multer.File;
}

describe('signPdf controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let jobRepo: { create: jest.Mock; save: jest.Mock };
  let fileRepo: { create: jest.Mock; save: jest.Mock };
  // Contenido en disco simulado, indexado por file.path
  let diskContents: Record<string, Buffer>;

  const pdfFile = () => mockFile('file', 'doc.pdf', 'application/pdf');
  const certFile = () => mockFile('cert', 'cert.pfx', 'application/x-pkcs12');
  const signatureFile = () => mockFile('signature', 'firma.png', 'image/png');

  /** Job guardado en el repo (la fila que leería el poller). */
  const savedJob = () => jobRepo.save.mock.calls[0][0];

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    mockResponse = { json: jsonMock, status: statusMock };
    mockNext = jest.fn();

    jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    fileRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
      entity === CompressionJob ? jobRepo : fileRepo,
    );

    diskContents = {
      'uploads/stored-file': PDF_BUFFER,
      'uploads/stored-cert': Buffer.from('pkcs12'),
      'uploads/stored-signature': PNG_BUFFER,
    };
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      const content = diskContents[p];
      if (!content) throw new Error(`ENOENT: ${p}`);
      return content;
    });
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function buildRequest(
    files: { [field: string]: Express.Multer.File[] },
    body: Record<string, unknown>,
  ): void {
    mockRequest = { files: files as Request['files'], body };
  }

  async function run(): Promise<void> {
    await signPdf(mockRequest as Request, mockResponse as Response, mockNext);
  }

  function expectValidationError(messagePart: string): ValidationError {
    expect(mockNext).toHaveBeenCalledTimes(1);
    const error = (mockNext as jest.Mock).mock.calls[0][0];
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toContain(messagePart);
    expect(jobRepo.save).not.toHaveBeenCalled();
    return error;
  }

  function expectUnlinked(...paths: string[]): void {
    for (const p of paths) {
      expect(fs.unlink).toHaveBeenCalledWith(p);
    }
  }

  describe('modo certificate (retrocompatibilidad)', () => {
    it('sin mode crea el job igual que antes (default certificate)', async () => {
      const pdf = pdfFile();
      const cert = certFile();
      buildRequest({ file: [pdf], cert: [cert] }, { password: 'secret' });

      await run();

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({ status: 'pending', operationType: 'sign' }),
        }),
      );

      const job = savedJob();
      expect(job.operationType).toBe('sign');
      expect(job.operationParams).toEqual(
        expect.objectContaining({
          mode: 'certificate',
          cert_path: path.resolve(cert.path),
          cert_password: 'secret',
        }),
      );
      // Sin campos de firma dibujada
      expect(job.operationParams.signature_path).toBeUndefined();
      expect(job.operationParams.x).toBeUndefined();
      expect(job.operationParams.pages).toBeUndefined();
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it('mode=certificate explícito funciona igual', async () => {
      buildRequest({ file: [pdfFile()], cert: [certFile()] }, { mode: 'certificate', password: 'secret' });

      await run();

      expect(statusMock).toHaveBeenCalledWith(201);
      expect(savedJob().operationParams.mode).toBe('certificate');
    });

    it('sin cert responde 400', async () => {
      buildRequest({ file: [pdfFile()] }, { password: 'secret' });
      await run();
      expectValidationError('Certificate file');
    });

    it('sin password responde 400', async () => {
      buildRequest({ file: [pdfFile()], cert: [certFile()] }, {});
      await run();
      expectValidationError('Certificate password is required');
    });

    it('acepta fieldName, reason, location y outputName', async () => {
      buildRequest({ file: [pdfFile()], cert: [certFile()] }, {
        password: 'secret',
        fieldName: 'Sig1',
        reason: 'Aprobación',
        location: 'Santo Domingo',
        outputName: 'contrato-firmado',
      });

      await run();

      expect(savedJob().operationParams).toEqual(
        expect.objectContaining({
          field_name: 'Sig1',
          reason: 'Aprobación',
          location: 'Santo Domingo',
          output_name: 'contrato-firmado',
        }),
      );
    });
  });

  describe('validación de mode', () => {
    it('mode desconocido responde 400 y borra los archivos subidos', async () => {
      const pdf = pdfFile();
      const cert = certFile();
      const sig = signatureFile();
      buildRequest({ file: [pdf], cert: [cert], signature: [sig] }, { mode: 'stamped' });

      await run();

      expectValidationError('mode must be one of: certificate, drawn, combined');
      expectUnlinked(pdf.path, cert.path, sig.path);
    });
  });

  describe('modo drawn', () => {
    const drawnBody = (overrides: Record<string, unknown> = {}) => ({
      mode: 'drawn',
      x: '0.1',
      y: '0.2',
      w: '0.3',
      ...overrides,
    });

    it('caso feliz: crea el job con los params del contrato del worker', async () => {
      const pdf = pdfFile();
      const sig = signatureFile();
      buildRequest({ file: [pdf], signature: [sig] }, drawnBody({ pages: '1,3-5' }));

      await run();

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);

      const params = savedJob().operationParams;
      expect(params).toEqual(
        expect.objectContaining({
          mode: 'drawn',
          signature_path: path.resolve(sig.path),
          pages: '1,3-5',
          x: 0.1,
          y: 0.2,
          w: 0.3,
        }),
      );
      // x, y, w deben ser números, no strings
      expect(typeof params.x).toBe('number');
      expect(typeof params.y).toBe('number');
      expect(typeof params.w).toBe('number');
      // Sin campos de certificado
      expect(params.cert_path).toBeUndefined();
      expect(params.cert_password).toBeUndefined();
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it('NO exige cert ni password', async () => {
      buildRequest({ file: [pdfFile()], signature: [signatureFile()] }, drawnBody());
      await run();
      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);
    });

    it('pages ausente usa "all"', async () => {
      buildRequest({ file: [pdfFile()], signature: [signatureFile()] }, drawnBody());
      await run();
      expect(savedJob().operationParams.pages).toBe('all');
    });

    it('acepta una imagen JPEG (magic bytes \\xFF\\xD8)', async () => {
      const sig = signatureFile();
      diskContents[sig.path] = JPEG_BUFFER;
      buildRequest({ file: [pdfFile()], signature: [sig] }, drawnBody());
      await run();
      expect(statusMock).toHaveBeenCalledWith(201);
    });

    it('sin signature responde 400 y borra el PDF subido', async () => {
      const pdf = pdfFile();
      buildRequest({ file: [pdf] }, drawnBody());

      await run();

      expectValidationError('Signature image (field "signature") is required');
      expectUnlinked(pdf.path);
    });

    it('magic bytes inválidos responden 400 y borran los archivos', async () => {
      const pdf = pdfFile();
      const sig = signatureFile();
      diskContents[sig.path] = TEXT_BUFFER;
      buildRequest({ file: [pdf], signature: [sig] }, drawnBody());

      await run();

      expectValidationError('Invalid signature image');
      expectUnlinked(pdf.path, sig.path);
    });

    it('PDF con magic bytes inválidos responde 400 y borra también la firma', async () => {
      const pdf = pdfFile();
      const sig = signatureFile();
      diskContents[pdf.path] = TEXT_BUFFER;
      buildRequest({ file: [pdf], signature: [sig] }, drawnBody());

      await run();

      expectValidationError('Invalid PDF file');
      expectUnlinked(pdf.path, sig.path);
    });

    it.each([
      ['x fuera de rango', { x: '1.5' }, 'Signature position (x, y) must be between 0 and 1'],
      ['y fuera de rango', { y: '-0.1' }, 'Signature position (x, y) must be between 0 and 1'],
      ['x no numérico', { x: 'abc' }, 'Signature placement "x" must be a number'],
      ['w = 0', { w: '0' }, 'Signature width (w) must be greater than 0 and at most 1'],
      ['w > 1', { w: '1.2' }, 'Signature width (w) must be greater than 0 and at most 1'],
    ])('%s responde 400', async (_name, override, message) => {
      const pdf = pdfFile();
      const sig = signatureFile();
      buildRequest({ file: [pdf], signature: [sig] }, drawnBody(override));

      await run();

      expectValidationError(message);
      expectUnlinked(pdf.path, sig.path);
    });

    it.each([['x'], ['y'], ['w']])('falta "%s" responde 400', async (coord) => {
      const body = drawnBody();
      delete (body as Record<string, unknown>)[coord];
      buildRequest({ file: [pdfFile()], signature: [signatureFile()] }, body);

      await run();

      expectValidationError('Signature placement (x, y, w) is required');
    });

    it.each([['1,,3'], ['abc'], ['1-'], ['3;5'], ['1, a-2']])(
      'pages malformado "%s" responde 400',
      async (pages) => {
        const pdf = pdfFile();
        const sig = signatureFile();
        buildRequest({ file: [pdf], signature: [sig] }, drawnBody({ pages }));

        await run();

        expectValidationError('pages must be "all" or a list like "1,3-5"');
        expectUnlinked(pdf.path, sig.path);
      },
    );
  });

  describe('modo combined', () => {
    const combinedBody = (overrides: Record<string, unknown> = {}) => ({
      mode: 'combined',
      password: 'secret',
      x: '0.5',
      y: '0',
      w: '1',
      pages: '2',
      ...overrides,
    });

    it('caso feliz: params de drawn + certificate en el mismo job', async () => {
      const pdf = pdfFile();
      const cert = certFile();
      const sig = signatureFile();
      buildRequest({ file: [pdf], cert: [cert], signature: [sig] }, combinedBody());

      await run();

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(201);
      expect(savedJob().operationParams).toEqual(
        expect.objectContaining({
          mode: 'combined',
          signature_path: path.resolve(sig.path),
          pages: '2',
          x: 0.5,
          y: 0,
          w: 1,
          cert_path: path.resolve(cert.path),
          cert_password: 'secret',
        }),
      );
      expect(fs.unlink).not.toHaveBeenCalled();
    });

    it('sin cert responde 400 y borra los archivos subidos', async () => {
      const pdf = pdfFile();
      const sig = signatureFile();
      buildRequest({ file: [pdf], signature: [sig] }, combinedBody());

      await run();

      expectValidationError('Certificate file (field "cert") is required');
      expectUnlinked(pdf.path, sig.path);
    });

    it('sin password responde 400 y borra los archivos subidos', async () => {
      const pdf = pdfFile();
      const cert = certFile();
      const sig = signatureFile();
      buildRequest({ file: [pdf], cert: [cert], signature: [sig] }, combinedBody({ password: '' }));

      await run();

      expectValidationError('Certificate password is required');
      expectUnlinked(pdf.path, cert.path, sig.path);
    });

    it('sin signature responde 400', async () => {
      buildRequest({ file: [pdfFile()], cert: [certFile()] }, combinedBody());
      await run();
      expectValidationError('Signature image (field "signature") is required');
    });
  });

  describe('sin PDF', () => {
    it('responde 400 en cualquier modo', async () => {
      buildRequest({}, { mode: 'drawn', x: '0.1', y: '0.1', w: '0.5' });
      await run();
      expectValidationError('PDF file (field "file") is required');
    });
  });
});

describe('editPdf controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jobRepo: { create: jest.Mock; save: jest.Mock };
  let fileRepo: { create: jest.Mock; save: jest.Mock };
  let diskContents: Record<string, Buffer>;

  const pdfFile = () => mockFile('file', 'doc.pdf', 'application/pdf');
  const imageFile = (n = 0) => mockFile('images', `img${n}.png`, 'image/png');
  const savedJob = () => jobRepo.save.mock.calls[0][0];

  beforeEach(() => {
    mockResponse = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    mockNext = jest.fn();
    jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    fileRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
      entity === CompressionJob ? jobRepo : fileRepo,
    );
    diskContents = { 'uploads/stored-file': PDF_BUFFER, 'uploads/stored-images': PNG_BUFFER };
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      const c = diskContents[p];
      if (!c) throw new Error(`ENOENT: ${p}`);
      return c;
    });
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => jest.clearAllMocks());

  function buildRequest(files: { [field: string]: Express.Multer.File[] }, body: Record<string, unknown>): void {
    mockRequest = { files: files as Request['files'], body };
  }
  async function run(): Promise<void> {
    await editPdf(mockRequest as Request, mockResponse as Response, mockNext);
  }
  function expectValidationError(part: string): void {
    expect(mockNext).toHaveBeenCalledTimes(1);
    const error = (mockNext as jest.Mock).mock.calls[0][0];
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain(part);
    expect(jobRepo.save).not.toHaveBeenCalled();
  }

  const textEdit = (o: Record<string, unknown> = {}) =>
    ({ type: 'text', page: 1, x: 0.1, y: 0.8, w: 0.4, h: 0.05, text: 'HOLA', ...o });

  it('caso feliz: crea el job pdf_edit con las ediciones normalizadas', async () => {
    buildRequest({ file: [pdfFile()] }, { edits: JSON.stringify([textEdit()]) });
    await run();

    expect(mockNext).not.toHaveBeenCalled();
    const job = savedJob();
    expect(job.operationType).toBe('pdf_edit');
    expect(job.operationParams.edits).toHaveLength(1);
    expect(job.operationParams.edits[0]).toEqual(
      expect.objectContaining({ type: 'text', page: 1, x: 0.1, text: 'HOLA', font_size: 12 }),
    );
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('acepta edits como valor ya parseado (no string)', async () => {
    buildRequest({ file: [pdfFile()] }, { edits: [textEdit()] });
    await run();
    expect(savedJob().operationParams.edits).toHaveLength(1);
  });

  it('traduce image_index a image_path y registra solo el PDF como original', async () => {
    const img = imageFile(0);
    buildRequest({ file: [pdfFile()], images: [img] }, {
      edits: JSON.stringify([{ type: 'image', page: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.1, image_index: 0 }]),
    });
    await run();

    const job = savedJob();
    expect(job.operationParams.edits[0].image_path).toBe(path.resolve(img.path));
    expect(job.operationParams.edits[0].image_index).toBeUndefined();
    // Solo el PDF va como original (las imágenes NO se registran en `files`).
    expect(fileRepo.save).toHaveBeenCalledTimes(1);
    const originals = fileRepo.save.mock.calls[0][0];
    expect(originals).toHaveLength(1);
    expect(originals[0].originalFilename).toBe('doc.pdf');
  });

  it('sin PDF responde 400', async () => {
    buildRequest({}, { edits: JSON.stringify([textEdit()]) });
    await run();
    expectValidationError('PDF file (field "file") is required');
  });

  it('edits no-JSON responde 400', async () => {
    buildRequest({ file: [pdfFile()] }, { edits: '{no json' });
    await run();
    expectValidationError('edits must be valid JSON');
  });

  it('edits vacío responde 400', async () => {
    buildRequest({ file: [pdfFile()] }, { edits: '[]' });
    await run();
    expectValidationError('At least one edit is required');
  });

  it.each([
    ['tipo inválido', { type: 'sombra' }, 'invalid type'],
    ['tipo redact (aún no en Fase A)', { type: 'redact' }, 'invalid type'],
    ['x fuera de rango', { x: 1.5 }, 'must be a number between 0 and 1'],
    ['h fuera de rango', { h: -0.1 }, 'must be a number between 0 and 1'],
    ['página 0', { page: 0 }, 'invalid page'],
    ['texto vacío en text', { text: '   ' }, 'needs a non-empty text'],
    ['font_size muy grande', { font_size: 200 }, 'font_size must be between 4 and 96'],
    ['color no hex', { color: 'rojo' }, 'color must be a hex'],
  ])('rechaza %s con 400 y borra el PDF', async (_n, override, message) => {
    const pdf = pdfFile();
    buildRequest({ file: [pdf] }, { edits: JSON.stringify([textEdit(override)]) });
    await run();
    expectValidationError(message);
    expect(fs.unlink).toHaveBeenCalledWith(pdf.path);
  });

  it('image_index fuera de rango responde 400', async () => {
    buildRequest({ file: [pdfFile()], images: [imageFile()] }, {
      edits: JSON.stringify([{ type: 'image', page: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.1, image_index: 5 }]),
    });
    await run();
    expectValidationError('references a missing image');
  });

  it('imagen con magic bytes inválidos responde 400 y borra todo', async () => {
    const pdf = pdfFile();
    const img = imageFile();
    diskContents[img.path] = TEXT_BUFFER;
    buildRequest({ file: [pdf], images: [img] }, {
      edits: JSON.stringify([{ type: 'image', page: 1, x: 0.5, y: 0.5, w: 0.2, h: 0.1, image_index: 0 }]),
    });
    await run();
    expectValidationError('Invalid signature image');
    expect(fs.unlink).toHaveBeenCalledWith(pdf.path);
    expect(fs.unlink).toHaveBeenCalledWith(img.path);
  });
});
