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
import { signPdf, editPdf, organizePdf, convertToPdf, pdfToWord } from '../../src/controllers/pdf-operation.controller';
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

    describe('sello de texto', () => {
      const withStamp = (stamp: unknown) =>
        buildRequest({ file: [pdfFile()], signature: [signatureFile()] },
          drawnBody({ stamp: typeof stamp === 'string' ? stamp : JSON.stringify(stamp) }));

      it('normaliza el sello y lo guarda en operation_params', async () => {
        withStamp({ text: '  AUTORIZADO  ', show_datetime: true, border: true, color: '#027A48' });
        await run();

        expect(mockNext).not.toHaveBeenCalled();
        expect(savedJob().operationParams.stamp).toEqual({
          text: 'AUTORIZADO',
          show_datetime: true,
          datetime_format: 'datetime',
          color: '#027A48',
          border: true,
        });
      });

      it('la fecha NO viaja desde el navegador: solo si se quiere y su formato', async () => {
        withStamp({ text: 'RECIBIDO', show_datetime: true, datetime_format: 'date', datetime: '01/01/2000' });
        await run();
        const stamp = savedJob().operationParams.stamp as Record<string, unknown>;
        expect(stamp.datetime_format).toBe('date');
        expect(stamp).not.toHaveProperty('datetime');
      });

      it('acepta booleanos como texto (multipart) y aplica los valores por defecto', async () => {
        withStamp({ text: 'ANULADO', show_datetime: 'false', border: 'true' });
        await run();
        expect(savedJob().operationParams.stamp).toEqual({
          text: 'ANULADO',
          show_datetime: false,
          datetime_format: 'datetime',
          color: '#B42318',
          border: true,
        });
      });

      it('acepta el sello ya parseado (no string)', async () => {
        buildRequest({ file: [pdfFile()], signature: [signatureFile()] },
          drawnBody({ stamp: { text: 'PAGADO' } }));
        await run();
        expect((savedJob().operationParams.stamp as Record<string, unknown>).text).toBe('PAGADO');
      });

      it('sin sello no añade la clave stamp', async () => {
        buildRequest({ file: [pdfFile()], signature: [signatureFile()] }, drawnBody());
        await run();
        expect(savedJob().operationParams.stamp).toBeUndefined();
      });

      it.each([
        ['stamp no-JSON', '{no json', 'stamp must be valid JSON'],
        ['sello vacío (ni texto ni fecha)', JSON.stringify({ text: '   ' }), 'needs a text or the date'],
        ['texto muy largo', JSON.stringify({ text: 'A'.repeat(61) }), 'too long'],
        ['formato inválido', JSON.stringify({ text: 'X', datetime_format: 'epoch' }), 'datetime_format'],
        ['color no hex', JSON.stringify({ text: 'X', color: 'rojo' }), 'hex color'],
        ['stamp es un array', JSON.stringify([{ text: 'X' }]), 'stamp must be an object'],
      ])('rechaza %s con 400 y borra los archivos subidos', async (_n, stamp, message) => {
        const pdf = pdfFile();
        const sig = signatureFile();
        buildRequest({ file: [pdf], signature: [sig] }, drawnBody({ stamp }));
        await run();

        expect(mockNext).toHaveBeenCalledTimes(1);
        const error = (mockNext as jest.Mock).mock.calls[0][0];
        expect(error).toBeInstanceOf(ValidationError);
        expect(error.message).toContain(message);
        expect(fs.unlink).toHaveBeenCalledWith(pdf.path);
        expect(fs.unlink).toHaveBeenCalledWith(sig.path);
      });
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

describe('organizePdf controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jobRepo: { create: jest.Mock; save: jest.Mock };
  let fileRepo: { create: jest.Mock; save: jest.Mock };

  // organize usa upload.single('file') + validatePdfFile (como extract/rotate),
  // así que el controlador recibe req.file, no req.files.
  const pdfFile = () => mockFile('file', 'doc.pdf', 'application/pdf');
  const savedJob = () => jobRepo.save.mock.calls[0][0];

  beforeEach(() => {
    mockResponse = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    mockNext = jest.fn();
    jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    fileRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
      entity === CompressionJob ? jobRepo : fileRepo,
    );
  });

  afterEach(() => jest.clearAllMocks());

  /** Con `withFile: false` simula la petición sin archivo (multer no puso req.file). */
  function buildRequest(body: Record<string, unknown>, withFile = true): void {
    mockRequest = { file: withFile ? pdfFile() : undefined, body } as Partial<Request>;
  }
  async function run(): Promise<void> {
    await organizePdf(mockRequest as Request, mockResponse as Response, mockNext);
  }
  function expectValidationError(part: string): void {
    expect(mockNext).toHaveBeenCalledTimes(1);
    const error = (mockNext as jest.Mock).mock.calls[0][0];
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain(part);
    expect(jobRepo.save).not.toHaveBeenCalled();
  }

  it('caso feliz: crea el job organize con la lista final de páginas', async () => {
    buildRequest({ pages: JSON.stringify([{ source: 3, rotate: 90 }, { source: 1 }]) });
    await run();

    expect(mockNext).not.toHaveBeenCalled();
    const job = savedJob();
    expect(job.operationType).toBe('organize');
    // El orden se respeta y `rotate` ausente vale 0.
    expect(job.operationParams.pages).toEqual([{ source: 3, rotate: 90 }, { source: 1, rotate: 0 }]);
  });

  it('acepta pages como valor ya parseado (no string)', async () => {
    buildRequest({ pages: [{ source: 2 }] });
    await run();
    expect(savedJob().operationParams.pages).toEqual([{ source: 2, rotate: 0 }]);
  });

  it('normaliza rotaciones negativas y mayores de 360', async () => {
    buildRequest({ pages: [{ source: 1, rotate: -90 }, { source: 2, rotate: 450 }] });
    await run();
    expect(savedJob().operationParams.pages).toEqual([
      { source: 1, rotate: 270 },
      { source: 2, rotate: 90 },
    ]);
  });

  it('guarda el outputName saneado', async () => {
    buildRequest({ pages: [{ source: 1 }], outputName: 'mi orden' });
    await run();
    expect(savedJob().operationParams.output_name).toBe('mi orden');
  });

  it('sin PDF responde 400', async () => {
    buildRequest({ pages: [{ source: 1 }] }, false);
    await run();
    expectValidationError('No file uploaded');
  });

  it.each([
    ['pages no-JSON', { pages: '{no json' }, 'pages must be valid JSON'],
    ['pages vacío', { pages: '[]' }, 'pages must be a non-empty array'],
    ['pages no es lista', { pages: JSON.stringify({ source: 1 }) }, 'pages must be a non-empty array'],
    ['source 0', { pages: [{ source: 0 }] }, 'invalid source'],
    ['source no entero', { pages: [{ source: 1.5 }] }, 'invalid source'],
    ['source ausente', { pages: [{ rotate: 90 }] }, 'invalid source'],
    ['rotate no múltiplo de 90', { pages: [{ source: 1, rotate: 45 }] }, 'multiple of 90'],
  ])('rechaza %s con 400', async (_n, body, message) => {
    buildRequest(body);
    await run();
    expectValidationError(message);
  });

  it('rechaza más de 5000 páginas', async () => {
    buildRequest({ pages: Array.from({ length: 5001 }, () => ({ source: 1 })) });
    await run();
    expectValidationError('Too many pages');
  });
});

describe('convertToPdf controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jobRepo: { create: jest.Mock; save: jest.Mock };
  let fileRepo: { create: jest.Mock; save: jest.Mock };
  let diskContents: Record<string, Buffer>;

  // Magic bytes por familia
  const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
  const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]);
  const RTF = Buffer.from('{\\rtf1\\ansi hola}');
  const TXT = Buffer.from('texto plano normal\ncon dos líneas');
  const BIN = Buffer.from([0x74, 0x00, 0x78, 0x00, 0x74, 0x00]); // NUL en el primer KB

  const savedJob = () => jobRepo.save.mock.calls[0][0];

  beforeEach(() => {
    mockResponse = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    mockNext = jest.fn();
    jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    fileRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
      entity === CompressionJob ? jobRepo : fileRepo,
    );
    diskContents = {};
    (fs.readFile as jest.Mock).mockImplementation(async (p: string) => {
      const c = diskContents[p];
      if (!c) throw new Error(`ENOENT: ${p}`);
      return c;
    });
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => jest.clearAllMocks());

  function buildRequest(originalname: string, content: Buffer | null, body: Record<string, unknown> = {}): void {
    if (content === null) {
      mockRequest = { file: undefined, body } as Partial<Request>;
      return;
    }
    const file = mockFile('file', originalname, 'application/octet-stream');
    diskContents[file.path] = content;
    mockRequest = { file, body } as Partial<Request>;
  }
  async function run(): Promise<void> {
    await convertToPdf(mockRequest as Request, mockResponse as Response, mockNext);
  }
  function expectValidationError(part: string): void {
    expect(mockNext).toHaveBeenCalledTimes(1);
    const error = (mockNext as jest.Mock).mock.calls[0][0];
    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain(part);
    expect(jobRepo.save).not.toHaveBeenCalled();
  }

  it.each([
    ['informe.docx', ZIP, 'docx'],
    ['viejo.doc', OLE, 'doc'],
    ['carta.rtf', RTF, 'rtf'],
    ['libro.xlsx', ZIP, 'xlsx'],
    ['charla.pptx', ZIP, 'pptx'],
    ['notas.TXT', TXT, 'txt'],
    ['foto.jpg', JPEG_BUFFER, 'jpg'],
    ['logo.png', PNG_BUFFER, 'png'],
  ])('caso feliz: %s crea el job convert', async (name, content, sourceExt) => {
    buildRequest(name, content);
    await run();

    expect(mockNext).not.toHaveBeenCalled();
    const job = savedJob();
    expect(job.operationType).toBe('convert');
    expect(job.operationParams.source_ext).toBe(sourceExt);
    expect(fs.unlink).not.toHaveBeenCalled();
  });

  it('guarda el outputName saneado', async () => {
    buildRequest('doc.docx', ZIP, { outputName: 'mi informe' });
    await run();
    expect(savedJob().operationParams.output_name).toBe('mi informe');
  });

  it('sin archivo responde 400', async () => {
    buildRequest('x', null);
    await run();
    expectValidationError('No file uploaded');
  });

  it.each([
    ['un .exe renombrado a .docx', 'troyano.docx', Buffer.from('MZ\x90\x00'), 'does not match'],
    ['un .txt renombrado a .doc', 'nota.doc', TXT, 'does not match'],
    ['un .txt con bytes binarios', 'raro.txt', BIN, 'does not match'],
    ['una imagen que no es png', 'foto.png', TXT, 'does not match'],
    ['un archivo vacío', 'vacio.docx', Buffer.alloc(0), 'empty'],
    ['una extensión no soportada', 'programa.exe', ZIP, 'Unsupported file type'],
  ])('rechaza %s con 400 y borra el archivo', async (_n, name, content, message) => {
    buildRequest(name, content);
    await run();
    expectValidationError(message);
    expect(fs.unlink).toHaveBeenCalledWith((mockRequest.file as Express.Multer.File).path);
  });
});

describe('pdfToWord controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jobRepo: { create: jest.Mock; save: jest.Mock };
  let fileRepo: { create: jest.Mock; save: jest.Mock };

  beforeEach(() => {
    mockResponse = { json: jest.fn(), status: jest.fn().mockReturnThis() };
    mockNext = jest.fn();
    jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    fileRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
      entity === CompressionJob ? jobRepo : fileRepo,
    );
  });

  afterEach(() => jest.clearAllMocks());

  async function run(): Promise<void> {
    await pdfToWord(mockRequest as Request, mockResponse as Response, mockNext);
  }

  it('caso feliz: crea el job pdf_to_word con el outputName saneado', async () => {
    mockRequest = {
      file: mockFile('file', 'contrato.pdf', 'application/pdf'),
      body: { outputName: 'contrato editable' },
    } as Partial<Request>;
    await run();

    expect(mockNext).not.toHaveBeenCalled();
    const job = jobRepo.save.mock.calls[0][0];
    expect(job.operationType).toBe('pdf_to_word');
    expect(job.operationParams.output_name).toBe('contrato editable');
  });

  it('sin archivo responde 400', async () => {
    mockRequest = { file: undefined, body: {} } as Partial<Request>;
    await run();
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect((mockNext as jest.Mock).mock.calls[0][0]).toBeInstanceOf(ValidationError);
    expect(jobRepo.save).not.toHaveBeenCalled();
  });
});
