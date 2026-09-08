import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/config/database');
jest.mock('fs/promises');
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import fs from 'fs/promises';
import { resolveSourceJob, resolveMergeSources } from '../../src/middlewares/source-job.middleware';
import { AppDataSource } from '../../src/config/database';
import { CompressionJob } from '../../src/models/job.model';
import { NotFoundError, ValidationError } from '../../src/utils/errors';

const SOURCE_JOB_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_JOB_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';

const OWNER = { id: 'owner-1', rol: 'user' as const };
const OTHER = { id: 'other-2', rol: 'user' as const };
const ADMIN = { id: 'admin-9', rol: 'admin' as const };

/** Archivo tal como lo deja multer tras una subida real. */
function uploadedFile(name = 'subido.pdf'): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/pdf',
    destination: '/uploads',
    filename: `${name}-stored`,
    path: `/uploads/${name}-stored`,
    size: 1234,
  } as Express.Multer.File;
}

/**
 * Prepara los repos que consulta el middleware. `job` es la fila de
 * compression_jobs y `file` la de su archivo de salida (null = no existe).
 */
function mockRepos(job: Partial<CompressionJob> | null, file: Record<string, unknown> | null): void {
  const jobRepo = { findOne: jest.fn().mockResolvedValue(job) };
  const fileRepo = { findOne: jest.fn().mockResolvedValue(file) };
  (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) =>
    entity === CompressionJob ? jobRepo : fileRepo,
  );
}

const completedJob = (overrides: Partial<CompressionJob> = {}): Partial<CompressionJob> => ({
  id: SOURCE_JOB_ID,
  userId: OWNER.id,
  status: 'completed',
  ...overrides,
});

const pdfOutput = (overrides: Record<string, unknown> = {}) => ({
  jobId: SOURCE_JOB_ID,
  fileType: 'output',
  originalFilename: 'resultado.pdf',
  filePath: '/outputs/resultado-stored.pdf',
  mimeType: 'application/pdf',
  ...overrides,
});

describe('resolveSourceJob — encadenar la salida de un job como entrada', () => {
  let next: NextFunction;
  const nextError = () => (next as jest.Mock).mock.calls[0]?.[0];

  beforeEach(() => {
    next = jest.fn();
    (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
    (fs.stat as jest.Mock).mockResolvedValue({ size: 5000 });
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function run(
    body: Record<string, unknown>,
    extra: Partial<Request> = {},
    user: { id: string; rol: 'admin' | 'user' } = OWNER,
  ) {
    const req = { body, user, ...extra } as unknown as Request;
    return { req, done: resolveSourceJob(req, {} as Response, next) };
  }

  it('sin sourceJobId deja pasar la subida y anota la sesión', async () => {
    const { req, done } = run({ sessionId: SESSION_ID }, { file: uploadedFile() });
    await done;

    expect(nextError()).toBeUndefined();
    expect(req.workSession).toEqual({ sessionId: SESSION_ID, parentJobId: null });
    expect(fs.copyFile).not.toHaveBeenCalled();
  });

  it('un sessionId que no es UUID se descarta en vez de propagarse', async () => {
    const { req, done } = run({ sessionId: 'no-soy-un-uuid' }, { file: uploadedFile() });
    await done;

    expect(req.workSession).toEqual({ sessionId: null, parentJobId: null });
  });

  it('materializa la salida del job y la deja en req.file', async () => {
    mockRepos(completedJob(), pdfOutput());
    const { req, done } = run({ sourceJobId: SOURCE_JOB_ID, sessionId: SESSION_ID });
    await done;

    expect(nextError()).toBeUndefined();
    expect(fs.copyFile).toHaveBeenCalledWith('/outputs/resultado-stored.pdf', expect.stringContaining('.pdf'));
    expect(req.file).toMatchObject({
      originalname: 'resultado.pdf',
      mimetype: 'application/pdf',
      size: 5000,
    });
    expect(req.workSession).toEqual({ sessionId: SESSION_ID, parentJobId: SOURCE_JOB_ID });
  });

  it('en rutas con .fields() rellena también req.files.file', async () => {
    mockRepos(completedJob(), pdfOutput());
    const { req, done } = run(
      { sourceJobId: SOURCE_JOB_ID },
      { files: { images: [uploadedFile('logo.png')] } as unknown as Request['files'] },
    );
    await done;

    const byField = req.files as { [field: string]: Express.Multer.File[] };
    expect(byField.file[0]).toBe(req.file);
    expect(byField.images).toHaveLength(1);
  });

  it('la subida gana sobre sourceJobId: no se materializa nada', async () => {
    mockRepos(completedJob(), pdfOutput());
    const { req, done } = run(
      { sourceJobId: SOURCE_JOB_ID, sessionId: SESSION_ID },
      { file: uploadedFile() },
    );
    await done;

    expect(fs.copyFile).not.toHaveBeenCalled();
    expect(req.file?.originalname).toBe('subido.pdf');
    expect(req.workSession?.parentJobId).toBeNull();
  });

  // --- Ownership: encadenar no puede ser una puerta lateral al archivo ajeno ---

  it('el job de OTRO usuario responde 404, igual que la descarga', async () => {
    mockRepos(completedJob({ userId: 'alguien-mas' }), pdfOutput());
    const { done } = run({ sourceJobId: SOURCE_JOB_ID }, {}, OTHER);
    await done;

    expect(nextError()).toBeInstanceOf(NotFoundError);
    expect(fs.copyFile).not.toHaveBeenCalled();
  });

  it('un job huérfano (sin dueño) responde 404 para un usuario normal', async () => {
    mockRepos(completedJob({ userId: null }), pdfOutput());
    const { done } = run({ sourceJobId: SOURCE_JOB_ID }, {}, OWNER);
    await done;

    expect(nextError()).toBeInstanceOf(NotFoundError);
    expect(fs.copyFile).not.toHaveBeenCalled();
  });

  it('el admin sí puede encadenar sobre un job ajeno', async () => {
    mockRepos(completedJob({ userId: 'alguien-mas' }), pdfOutput());
    const { req, done } = run({ sourceJobId: SOURCE_JOB_ID }, {}, ADMIN);
    await done;

    expect(nextError()).toBeUndefined();
    expect(req.file).toBeDefined();
  });

  it('un job inexistente responde 404', async () => {
    mockRepos(null, null);
    const { done } = run({ sourceJobId: SOURCE_JOB_ID });
    await done;

    expect(nextError()).toBeInstanceOf(NotFoundError);
  });

  // --- Qué se puede encadenar ---

  it('rechaza encadenar sobre un job que aún no terminó', async () => {
    mockRepos(completedJob({ status: 'processing' }), pdfOutput());
    const { done } = run({ sourceJobId: SOURCE_JOB_ID });
    await done;

    expect(nextError()).toBeInstanceOf(ValidationError);
    expect(nextError().message).toContain('not finished');
  });

  it('rechaza encadenar sobre una salida que no es PDF (ZIP de split, .docx…)', async () => {
    mockRepos(
      completedJob(),
      pdfOutput({ originalFilename: 'partes.zip', mimeType: 'application/zip' }),
    );
    const { done } = run({ sourceJobId: SOURCE_JOB_ID });
    await done;

    expect(nextError()).toBeInstanceOf(ValidationError);
    expect(nextError().message).toContain('not a PDF');
  });

  it('acepta una salida PDF aunque el mimetype guardado sea genérico', async () => {
    mockRepos(
      completedJob(),
      pdfOutput({ originalFilename: 'resultado.PDF', mimeType: 'application/octet-stream' }),
    );
    const { req, done } = run({ sourceJobId: SOURCE_JOB_ID });
    await done;

    expect(nextError()).toBeUndefined();
    expect(req.file).toBeDefined();
  });

  it('rechaza un sourceJobId que no tiene forma de id', async () => {
    const { done } = run({ sourceJobId: '../../etc/passwd' });
    await done;

    expect(nextError()).toBeInstanceOf(ValidationError);
    expect(AppDataSource.getRepository).not.toHaveBeenCalled();
  });
});

describe('resolveMergeSources — secuencia mixta de jobs y subidas', () => {
  let next: NextFunction;
  const nextError = () => (next as jest.Mock).mock.calls[0]?.[0];

  beforeEach(() => {
    next = jest.fn();
    (fs.copyFile as jest.Mock).mockResolvedValue(undefined);
    (fs.stat as jest.Mock).mockResolvedValue({ size: 5000 });
    (fs.unlink as jest.Mock).mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  function run(
    body: Record<string, unknown>,
    files: Express.Multer.File[],
    user: { id: string; rol: 'admin' | 'user' } = OWNER,
  ) {
    const req = { body, user, files } as unknown as Request;
    return { req, done: resolveMergeSources(req, {} as Response, next) };
  }

  it('sin `sources` no toca nada: merge clásico de archivos subidos', async () => {
    const files = [uploadedFile('a.pdf'), uploadedFile('b.pdf')];
    const { req, done } = run({ sessionId: SESSION_ID }, files);
    await done;

    expect(nextError()).toBeUndefined();
    expect(req.files).toBe(files);
    expect(req.workSession).toEqual({ sessionId: SESSION_ID, parentJobId: null });
  });

  it('respeta el orden pedido al insertar una subida ENTRE dos jobs', async () => {
    mockRepos(completedJob(), pdfOutput());
    const inserted = uploadedFile('insertado.pdf');
    const { req, done } = run(
      {
        sessionId: SESSION_ID,
        sources: JSON.stringify([
          { jobId: SOURCE_JOB_ID },
          { upload: 0 },
          { jobId: OTHER_JOB_ID },
        ]),
      },
      [inserted],
    );
    await done;

    expect(nextError()).toBeUndefined();
    const ordered = req.files as Express.Multer.File[];
    expect(ordered).toHaveLength(3);
    expect(ordered[1]).toBe(inserted);
    // El documento de trabajo (primer job de la secuencia) es el padre.
    expect(req.workSession).toEqual({ sessionId: SESSION_ID, parentJobId: SOURCE_JOB_ID });
  });

  it('borra del disco las subidas que la secuencia no menciona', async () => {
    mockRepos(completedJob(), pdfOutput());
    const usada = uploadedFile('usada.pdf');
    const sobrante = uploadedFile('sobrante.pdf');
    const { done } = run(
      { sources: JSON.stringify([{ jobId: SOURCE_JOB_ID }, { upload: 0 }]) },
      [usada, sobrante],
    );
    await done;

    expect(nextError()).toBeUndefined();
    expect(fs.unlink).toHaveBeenCalledWith(sobrante.path);
    expect(fs.unlink).not.toHaveBeenCalledWith(usada.path);
  });

  it('rechaza una secuencia de menos de 2 piezas', async () => {
    const { done } = run({ sources: JSON.stringify([{ upload: 0 }]) }, [uploadedFile()]);
    await done;

    expect(nextError()).toBeInstanceOf(ValidationError);
  });

  it('rechaza una referencia a una subida que no llegó', async () => {
    const { done } = run(
      { sources: JSON.stringify([{ upload: 0 }, { upload: 7 }]) },
      [uploadedFile()],
    );
    await done;

    expect(nextError()).toBeInstanceOf(ValidationError);
  });

  it('aplica el ownership también a los jobs de la secuencia', async () => {
    mockRepos(completedJob({ userId: 'alguien-mas' }), pdfOutput());
    const { done } = run(
      { sources: JSON.stringify([{ jobId: SOURCE_JOB_ID }, { upload: 0 }]) },
      [uploadedFile()],
      OTHER,
    );
    await done;

    expect(nextError()).toBeInstanceOf(NotFoundError);
  });
});
