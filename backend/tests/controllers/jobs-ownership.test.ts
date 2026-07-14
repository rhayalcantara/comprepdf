import { Request, Response, NextFunction } from 'express';

jest.mock('../../src/config/database');
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

import { getJobStatus, downloadFile, deleteJob, compressPdf } from '../../src/controllers/compress.controller';
import { listJobs } from '../../src/controllers/jobs.controller';
import { AppDataSource } from '../../src/config/database';
import { CompressionJob, JobModel } from '../../src/models/job.model';
import { File } from '../../src/models/file.model';
import { NotFoundError } from '../../src/utils/errors';

type PartialJob = Partial<CompressionJob> & { userId?: string | null };

function makeJob(overrides: PartialJob = {}): CompressionJob {
  return {
    id: 'job-1',
    userId: 'owner-1',
    status: 'completed',
    operationType: 'compress',
    createdAt: new Date('2026-01-01'),
    completedAt: new Date('2026-01-01'),
    files: [
      {
        fileType: 'original',
        originalFilename: 'doc.pdf',
        fileSize: 1000,
        expiresAt: new Date('2026-01-02'),
      },
      {
        fileType: 'compressed',
        originalFilename: 'doc.pdf',
        fileSize: 400,
        expiresAt: new Date('2026-01-02'),
      },
    ],
    ...overrides,
  } as CompressionJob;
}

const OWNER = { id: 'owner-1', rol: 'user' as const };
const OTHER = { id: 'other-2', rol: 'user' as const };
const ADMIN = { id: 'admin-9', rol: 'admin' as const };

describe('ownership de jobs', () => {
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let downloadMock: jest.Mock;

  const nextError = () => (mockNext as jest.Mock).mock.calls[0]?.[0];

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();
    downloadMock = jest.fn();
    mockResponse = { json: jsonMock, status: statusMock, download: downloadMock as unknown as Response['download'] };
    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  describe('getJobStatus', () => {
    function run(job: CompressionJob | null, user: { id: string; rol: 'admin' | 'user' } | undefined) {
      const jobRepo = { findOne: jest.fn().mockResolvedValue(job) };
      (AppDataSource.getRepository as jest.Mock).mockReturnValue(jobRepo);
      const req = { params: { jobId: 'job-1' }, user } as unknown as Request;
      return getJobStatus(req, mockResponse as Response, mockNext);
    }

    it('el dueño recibe 200', async () => {
      await run(makeJob(), OWNER);
      expect(mockNext).not.toHaveBeenCalled();
      expect(jsonMock.mock.calls[0][0]).toEqual(
        expect.objectContaining({ success: true, data: expect.objectContaining({ jobId: 'job-1' }) }),
      );
    });

    it('un usuario ajeno recibe 404 (no 403)', async () => {
      await run(makeJob(), OTHER);
      expect(nextError()).toBeInstanceOf(NotFoundError);
      expect(nextError().statusCode).toBe(404);
      expect(jsonMock).not.toHaveBeenCalled();
    });

    it('el admin ve cualquier job (200)', async () => {
      await run(makeJob(), ADMIN);
      expect(mockNext).not.toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalled();
    });

    it('job huérfano (userId null): 404 para usuario normal', async () => {
      await run(makeJob({ userId: null }), OWNER);
      expect(nextError()).toBeInstanceOf(NotFoundError);
    });

    it('job huérfano (userId null): visible solo para admin (200)', async () => {
      await run(makeJob({ userId: null }), ADMIN);
      expect(mockNext).not.toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalled();
    });

    it('job inexistente: 404', async () => {
      await run(null, OWNER);
      expect(nextError()).toBeInstanceOf(NotFoundError);
    });
  });

  describe('downloadFile', () => {
    function run(job: CompressionJob | null, user: { id: string; rol: 'admin' | 'user' }) {
      const jobRepo = { findOne: jest.fn().mockResolvedValue(job) };
      const fileRepo = {
        findOne: jest.fn().mockResolvedValue({
          fileType: 'compressed',
          filePath: '/out/doc.pdf',
          originalFilename: 'doc.pdf',
        }),
      };
      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
        entity === CompressionJob ? jobRepo : fileRepo,
      );
      const req = { params: { jobId: 'job-1' }, user } as unknown as Request;
      return downloadFile(req, mockResponse as Response, mockNext);
    }

    it('el dueño descarga (res.download)', async () => {
      await run(makeJob(), OWNER);
      expect(mockNext).not.toHaveBeenCalled();
      expect(downloadMock).toHaveBeenCalledWith('/out/doc.pdf', 'compressed_doc.pdf');
    });

    it('un usuario ajeno recibe 404 y NO descarga', async () => {
      await run(makeJob(), OTHER);
      expect(nextError()).toBeInstanceOf(NotFoundError);
      expect(downloadMock).not.toHaveBeenCalled();
    });

    it('el admin descarga cualquier job', async () => {
      await run(makeJob({ userId: 'someone-else' }), ADMIN);
      expect(downloadMock).toHaveBeenCalled();
    });
  });

  describe('compressPdf (guarda ownership al crear)', () => {
    it('setea user_id = req.user.id en el job creado', async () => {
      const jobRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
      const fileRepo = { create: jest.fn((x) => x), save: jest.fn(async (x) => x) };
      (AppDataSource.getRepository as jest.Mock).mockImplementation((entity) =>
        entity === CompressionJob ? jobRepo : fileRepo,
      );

      const req = {
        file: {
          filename: 'stored.pdf',
          originalname: 'doc.pdf',
          path: 'uploads/stored.pdf',
          size: 1000,
          mimetype: 'application/pdf',
        },
        body: { compressionLevel: 'medium' },
        user: OWNER,
      } as unknown as Request;

      await compressPdf(req, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(jobRepo.save.mock.calls[0][0].userId).toBe('owner-1');
    });
  });

  describe('deleteJob', () => {
    function run(job: CompressionJob | null, user: { id: string; rol: 'admin' | 'user' }) {
      const deleteFn = jest.fn().mockResolvedValue({ affected: 1 });
      const jobRepo = { findOne: jest.fn().mockResolvedValue(job), delete: deleteFn };
      (AppDataSource.getRepository as jest.Mock).mockReturnValue(jobRepo);
      const req = { params: { jobId: 'job-1' }, user } as unknown as Request;
      return { promise: deleteJob(req, mockResponse as Response, mockNext), deleteFn };
    }

    it('el dueño borra su job', async () => {
      const { promise, deleteFn } = run(makeJob(), OWNER);
      await promise;
      expect(deleteFn).toHaveBeenCalledWith('job-1');
      expect(jsonMock.mock.calls[0][0].success).toBe(true);
    });

    it('un usuario ajeno recibe 404 y NO borra', async () => {
      const { promise, deleteFn } = run(makeJob(), OTHER);
      await promise;
      expect(nextError()).toBeInstanceOf(NotFoundError);
      expect(deleteFn).not.toHaveBeenCalled();
    });

    it('el admin puede borrar cualquier job', async () => {
      const { promise, deleteFn } = run(makeJob({ userId: 'x' }), ADMIN);
      await promise;
      expect(deleteFn).toHaveBeenCalledWith('job-1');
    });
  });
});

describe('GET /jobs (listJobs)', () => {
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    mockResponse = { json: jsonMock, status: jest.fn().mockReturnThis() };
    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  it('usuario normal: lista SOLO sus jobs, paginado', async () => {
    const listByUser = jest.spyOn(JobModel, 'listByUser').mockResolvedValue({
      jobs: [makeJobFor('owner-1')],
      total: 1,
    });
    const listAll = jest.spyOn(JobModel, 'listAll');

    const req = { query: { page: '1', limit: '10' }, user: { id: 'owner-1', rol: 'user' } } as unknown as Request;
    await listJobs(req, mockResponse as Response, mockNext);

    expect(listByUser).toHaveBeenCalledWith('owner-1', { page: 1, limit: 10 });
    expect(listAll).not.toHaveBeenCalled();

    const payload = jsonMock.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.data.pagination).toEqual({ page: 1, limit: 10, total: 1, totalPages: 1 });
    expect(payload.data.items[0].jobId).toBe('job-1');
    // Un usuario normal NO recibe el campo username.
    expect(payload.data.items[0].username).toBeUndefined();
  });

  it('usa defaults de paginación (page=1, limit=20) y topa limit a 100', async () => {
    const listByUser = jest.spyOn(JobModel, 'listByUser').mockResolvedValue({ jobs: [], total: 0 });

    const req = { query: { limit: '5000' }, user: { id: 'owner-1', rol: 'user' } } as unknown as Request;
    await listJobs(req, mockResponse as Response, mockNext);

    expect(listByUser).toHaveBeenCalledWith('owner-1', { page: 1, limit: 100 });
  });

  it('admin con ?all=true: lista TODO e incluye username', async () => {
    const listAll = jest.spyOn(JobModel, 'listAll').mockResolvedValue({
      jobs: [makeJobFor('owner-1'), makeJobFor(null)],
      total: 2,
    });
    jest.spyOn(JobModel, 'usernamesByIds').mockResolvedValue(new Map([['owner-1', 'jdoe']]));

    const req = { query: { all: 'true' }, user: { id: 'admin-9', rol: 'admin' } } as unknown as Request;
    await listJobs(req, mockResponse as Response, mockNext);

    expect(listAll).toHaveBeenCalledWith({ page: 1, limit: 20 });
    const items = jsonMock.mock.calls[0][0].data.items;
    expect(items[0].username).toBe('jdoe');
    // Job huérfano → username null en modo admin.
    expect(items[1].username).toBeNull();
  });

  it('admin SIN ?all=true: ve solo los suyos (listByUser)', async () => {
    const listByUser = jest.spyOn(JobModel, 'listByUser').mockResolvedValue({ jobs: [], total: 0 });
    const listAll = jest.spyOn(JobModel, 'listAll');

    const req = { query: {}, user: { id: 'admin-9', rol: 'admin' } } as unknown as Request;
    await listJobs(req, mockResponse as Response, mockNext);

    expect(listByUser).toHaveBeenCalledWith('admin-9', { page: 1, limit: 20 });
    expect(listAll).not.toHaveBeenCalled();
  });

  it('usuario normal con ?all=true NO escala privilegios (sigue viendo solo los suyos)', async () => {
    const listByUser = jest.spyOn(JobModel, 'listByUser').mockResolvedValue({ jobs: [], total: 0 });
    const listAll = jest.spyOn(JobModel, 'listAll');

    const req = { query: { all: 'true' }, user: { id: 'owner-1', rol: 'user' } } as unknown as Request;
    await listJobs(req, mockResponse as Response, mockNext);

    expect(listByUser).toHaveBeenCalledWith('owner-1', { page: 1, limit: 20 });
    expect(listAll).not.toHaveBeenCalled();
  });
});

/** Job de listado con un `user_id` concreto (o huérfano). */
function makeJobFor(userId: string | null): CompressionJob {
  return {
    id: 'job-1',
    userId,
    status: 'completed',
    operationType: 'compress',
    compressionLevel: 'medium',
    createdAt: new Date('2026-01-01'),
    completedAt: new Date('2026-01-01'),
    files: [
      { fileType: 'original', originalFilename: 'doc.pdf', fileSize: 1000, expiresAt: new Date('2026-01-02') } as File,
      { fileType: 'output', originalFilename: 'doc.pdf', fileSize: 400, expiresAt: new Date('2026-01-02') } as File,
    ],
  } as CompressionJob;
}
