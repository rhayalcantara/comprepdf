import { Request, Response, NextFunction } from 'express';
import {
  getOverview,
  getDailyStats,
  getRecentJobs,
  getOperationStats,
  getCompressionLevelStats,
} from '../../src/controllers/stats.controller';
import { AppDataSource } from '../../src/config/database';
import { CompressionJob, JobModel } from '../../src/models/job.model';
import { CompressionStats } from '../../src/models/stats.model';
import { File } from '../../src/models/file.model';
import { User } from '../../src/models/user.model';

jest.mock('../../src/config/database');

/**
 * Query-builder falso encadenable: cada método devuelve `this`; los métodos
 * terminales (`getRawMany`/`getRawOne`/`getMany`) devuelven lo que se inyecte.
 * Registra los `where`/`andWhere`/`leftJoin` para poder verificar ownership.
 */
function makeQb(result: { rawMany?: unknown[]; rawOne?: unknown; many?: unknown[] }) {
  const calls: Record<string, unknown[][]> = {};
  const rec = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return qb;
  };
  const qb: Record<string, unknown> = {
    select: rec('select'),
    addSelect: rec('addSelect'),
    where: rec('where'),
    andWhere: rec('andWhere'),
    groupBy: rec('groupBy'),
    addGroupBy: rec('addGroupBy'),
    orderBy: rec('orderBy'),
    leftJoin: rec('leftJoin'),
    leftJoinAndSelect: rec('leftJoinAndSelect'),
    limit: rec('limit'),
    getRawMany: jest.fn().mockResolvedValue(result.rawMany ?? []),
    getRawOne: jest.fn().mockResolvedValue(result.rawOne ?? undefined),
    getMany: jest.fn().mockResolvedValue(result.many ?? []),
    __calls: calls,
  };
  return qb;
}

describe('Stats Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();

    // Por defecto un admin: camino "global" (sin filtro por usuario).
    mockRequest = {
      query: {},
      params: {},
      user: { id: 'admin-1', rol: 'admin' } as any,
    };

    mockResponse = { json: jsonMock, status: statusMock };
    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  /**
   * Configura `AppDataSource.getRepository` para devolver un repo por entidad.
   * `qbs` mapea entidad → función que produce el query-builder falso a devolver
   * (se invoca en cada `createQueryBuilder`).
   */
  function mockRepos(
    qbs: Map<unknown, () => Record<string, unknown>>,
    counts?: Map<unknown, jest.Mock>,
  ) {
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: unknown) => {
      const makeCurrentQb = qbs.get(entity);
      return {
        createQueryBuilder: jest.fn(() => (makeCurrentQb ? makeCurrentQb() : makeQb({}))),
        count: counts?.get(entity) ?? jest.fn().mockResolvedValue(0),
      };
    });
  }

  describe('getOverview', () => {
    it('devuelve bloque agnóstico, byOperation, compression y storage (admin: + users/topUsers)', async () => {
      const statusQb = makeQb({
        rawMany: [
          { status: 'completed', count: '85' },
          { status: 'failed', count: '5' },
          { status: 'pending', count: '7' },
          { status: 'processing', count: '3' },
        ],
      });
      const byOpQb = makeQb({
        rawMany: [
          { operation: 'compress', total: '60', completed: '55', failed: '2' },
          { operation: 'merge', total: '40', completed: '30', failed: '3' },
        ],
      });
      const topQb = makeQb({ rawMany: [{ userId: 'u1', jobs: '70' }, { userId: 'u2', jobs: '30' }] });
      // El repo de jobs crea 3 query-builders en orden: status, byOperation, topUsers.
      const jobQbSeq = [statusQb, byOpQb, topQb];
      let jobQbIdx = 0;

      const statsQb = makeQb({
        rawOne: {
          avgCompressionRatio: '65.50',
          avgProcessingTime: 12500,
          totalOriginalSize: 1000000000,
          totalCompressedSize: 350000000,
          totalCompressions: '60',
        },
      });
      const fileQb = makeQb({ rawOne: { outputBytes: '420000000' } });
      const userQb = makeQb({
        rawMany: [
          { estado: 'activo', count: '8' },
          { estado: 'inactivo', count: '1' },
          { estado: 'pendiente', count: '2' },
        ],
      });

      const qbs = new Map<unknown, () => Record<string, unknown>>([
        [CompressionJob, () => jobQbSeq[jobQbIdx++]],
        [CompressionStats, () => statsQb],
        [File, () => fileQb],
        [User, () => userQb],
      ]);
      mockRepos(qbs);

      jest
        .spyOn(JobModel, 'usernamesByIds')
        .mockResolvedValue(new Map([['u1', 'alice'], ['u2', 'bob']]));

      await getOverview(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      const payload = jsonMock.mock.calls[0][0];
      expect(payload.success).toBe(true);
      const d = payload.data;

      // Agnóstico.
      expect(d.totalJobs).toBe(100);
      expect(d.completedJobs).toBe(85);
      expect(d.failedJobs).toBe(5);
      expect(d.pendingJobs).toBe(7);
      expect(d.processingJobs).toBe(3);
      expect(d.successRate).toBe(85);

      // byOperation.
      expect(d.byOperation).toEqual([
        { operation: 'compress', total: 60, completed: 55, failed: 2 },
        { operation: 'merge', total: 40, completed: 30, failed: 3 },
      ]);

      // Bloque compresión.
      expect(d.compression).toEqual({
        avgCompressionRatio: '65.50',
        avgProcessingTimeMs: 12500,
        totalOriginalBytes: 1000000000,
        totalCompressedBytes: 350000000,
        totalSpaceSaved: 650000000,
        totalCompressions: 60,
      });

      // Storage.
      expect(d.storage).toEqual({ outputBytes: 420000000 });

      // Admin: users + topUsers.
      expect(d.users).toEqual({ total: 11, activos: 8, inactivos: 1, pendientes: 2 });
      expect(d.topUsers).toEqual([
        { userId: 'u1', username: 'alice', jobs: 70 },
        { userId: 'u2', username: 'bob', jobs: 30 },
      ]);

      // Compatibilidad: campos legacy a nivel superior.
      expect(d.avgCompressionRatio).toBe('65.50');
      expect(d.totalSpaceSaved).toBe(650000000);
      expect(d.totalCompressions).toBe(60);
    });

    it('usuario normal: filtra por user_id y NO incluye users/topUsers', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' } as any;

      const statusQb = makeQb({ rawMany: [{ status: 'completed', count: '3' }] });
      const byOpQb = makeQb({ rawMany: [{ operation: 'compress', total: '3', completed: '3', failed: '0' }] });
      const jobQbSeq = [statusQb, byOpQb];
      let idx = 0;

      const statsQb = makeQb({
        rawOne: {
          avgCompressionRatio: '50.00',
          avgProcessingTime: 1000,
          totalOriginalSize: 200,
          totalCompressedSize: 100,
          totalCompressions: '3',
        },
      });
      const fileQb = makeQb({ rawOne: { outputBytes: '100' } });

      const qbs = new Map<unknown, () => Record<string, unknown>>([
        [CompressionJob, () => jobQbSeq[idx++]],
        [CompressionStats, () => statsQb],
        [File, () => fileQb],
      ]);
      mockRepos(qbs);

      await getOverview(mockRequest as Request, mockResponse as Response, mockNext);

      const d = jsonMock.mock.calls[0][0].data;
      expect(d.users).toBeUndefined();
      expect(d.topUsers).toBeUndefined();

      // Ownership: los conteos y agregados llevan el filtro por dueño.
      expect((statusQb.__calls as any).where).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
      expect((byOpQb.__calls as any).where).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
      expect((statsQb.__calls as any).leftJoin).toContainEqual(['stats.job', 'job']);
      expect((statsQb.__calls as any).where).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
      expect((fileQb.__calls as any).andWhere).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
    });

    it('propaga errores a next', async () => {
      const error = new Error('Database error');
      (AppDataSource.getRepository as jest.Mock).mockImplementation(() => {
        throw error;
      });
      await getOverview(mockRequest as Request, mockResponse as Response, mockNext);
      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('getDailyStats', () => {
    it('cuenta TODAS las operaciones por día con byOperation (no solo compresión)', async () => {
      mockRequest.query = { days: '7' };

      const jobQb = makeQb({
        rawMany: [
          { date: '2026-07-10', operation: 'compress', count: '4' },
          { date: '2026-07-10', operation: 'merge', count: '2' },
          { date: '2026-07-11', operation: 'split', count: '5' },
        ],
      });
      const compQb = makeQb({
        rawMany: [
          {
            date: '2026-07-10',
            count: '4',
            avgRatio: '65.50',
            avgTime: '12500',
            totalOriginal: '100000000',
            totalCompressed: '35000000',
          },
        ],
      });

      const qbs = new Map<unknown, () => Record<string, unknown>>([
        [CompressionJob, () => jobQb],
        [CompressionStats, () => compQb],
      ]);
      mockRepos(qbs);

      await getDailyStats(mockRequest as Request, mockResponse as Response, mockNext);

      const data = jsonMock.mock.calls[0][0].data;
      expect(data).toHaveLength(2);

      const d10 = data.find((x: any) => x.date === '2026-07-10');
      expect(d10.total).toBe(6);
      expect(d10.byOperation).toEqual({ compress: 4, merge: 2 });
      // Campos legacy de compresión preservados.
      expect(d10.compressions).toBe(4);
      expect(d10.avgCompressionRatio).toBe('65.50');
      expect(d10.spaceSaved).toBe(65000000);

      const d11 = data.find((x: any) => x.date === '2026-07-11');
      expect(d11.total).toBe(5);
      expect(d11.byOperation).toEqual({ split: 5 });
      // Día sin compresión: legacy a cero.
      expect(d11.compressions).toBe(0);
    });

    it('respeta el filtro por días y devuelve [] sin actividad', async () => {
      mockRequest.query = { days: '30' };
      const jobQb = makeQb({ rawMany: [] });
      const compQb = makeQb({ rawMany: [] });
      const qbs = new Map<unknown, () => Record<string, unknown>>([
        [CompressionJob, () => jobQb],
        [CompressionStats, () => compQb],
      ]);
      mockRepos(qbs);

      await getDailyStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({ success: true, data: [] });
      // El where de fecha usa una fecha límite (>= startDate).
      const whereArgs = (jobQb.__calls as any).where[0];
      expect(whereArgs[0]).toBe('job.created_at >= :startDate');
      expect(whereArgs[1].startDate).toBeInstanceOf(Date);
    });

    it('usuario normal: filtra por user_id', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' } as any;
      const jobQb = makeQb({ rawMany: [] });
      const compQb = makeQb({ rawMany: [] });
      const qbs = new Map<unknown, () => Record<string, unknown>>([
        [CompressionJob, () => jobQb],
        [CompressionStats, () => compQb],
      ]);
      mockRepos(qbs);

      await getDailyStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect((jobQb.__calls as any).andWhere).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
      expect((compQb.__calls as any).andWhere).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
    });
  });

  describe('getRecentJobs', () => {
    const jobsFixture = [
      {
        id: 'job-1',
        status: 'completed',
        operationType: 'compress',
        compressionLevel: 'medium',
        userId: 'u1',
        createdAt: new Date('2026-07-11'),
        completedAt: new Date('2026-07-11'),
        files: [
          { fileType: 'original', originalFilename: 'test.pdf', fileSize: BigInt(1000000) },
          { fileType: 'compressed', originalFilename: 'test.pdf', fileSize: BigInt(350000) },
        ],
      },
      {
        id: 'job-2',
        status: 'completed',
        operationType: 'merge',
        compressionLevel: null,
        userId: 'u2',
        createdAt: new Date('2026-07-11'),
        completedAt: new Date('2026-07-11'),
        files: [{ fileType: 'output', originalFilename: 'merged.pdf', fileSize: BigInt(500000) }],
      },
    ];

    it('admin: incluye operationType, username y columnas de compresión opcionales', async () => {
      mockRequest.query = { limit: '5' };
      const jobQb = makeQb({ many: jobsFixture });
      const qbs = new Map<unknown, () => Record<string, unknown>>([[CompressionJob, () => jobQb]]);
      mockRepos(qbs);
      jest.spyOn(JobModel, 'usernamesByIds').mockResolvedValue(new Map([['u1', 'alice'], ['u2', 'bob']]));

      await getRecentJobs(mockRequest as Request, mockResponse as Response, mockNext);

      const data = jsonMock.mock.calls[0][0].data;
      expect(data[0]).toMatchObject({
        jobId: 'job-1',
        operationType: 'compress',
        compressionLevel: 'medium',
        compressionRatio: 65,
        username: 'alice',
      });
      // Operación no-compresión: columnas de compresión null.
      expect(data[1]).toMatchObject({
        jobId: 'job-2',
        operationType: 'merge',
        compressionLevel: null,
        compressedSize: null,
        compressionRatio: null,
        username: 'bob',
      });
    });

    it('usuario normal: filtra por user_id y NO incluye username', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' } as any;
      mockRequest.query = { limit: '5' };
      const jobQb = makeQb({ many: [] });
      const qbs = new Map<unknown, () => Record<string, unknown>>([[CompressionJob, () => jobQb]]);
      mockRepos(qbs);
      const spy = jest.spyOn(JobModel, 'usernamesByIds');

      await getRecentJobs(mockRequest as Request, mockResponse as Response, mockNext);

      expect((jobQb.__calls as any).where).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
      expect(spy).not.toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalledWith({ success: true, data: [] });
    });
  });

  describe('getOperationStats', () => {
    it('cuenta por operación y anida compressionLevels solo en compress', async () => {
      const opQb = makeQb({
        rawMany: [
          { operation: 'compress', count: '60' },
          { operation: 'merge', count: '40' },
        ],
      });
      const levelQb = makeQb({
        rawMany: [
          { level: 'low', count: '10' },
          { level: 'medium', count: '35' },
          { level: 'high', count: '15' },
        ],
      });
      const jobQbSeq = [opQb, levelQb];
      let idx = 0;
      const qbs = new Map<unknown, () => Record<string, unknown>>([
        [CompressionJob, () => jobQbSeq[idx++]],
      ]);
      mockRepos(qbs);

      await getOperationStats(mockRequest as Request, mockResponse as Response, mockNext);

      const data = jsonMock.mock.calls[0][0].data;
      expect(data).toEqual([
        {
          operation: 'compress',
          count: 60,
          compressionLevels: [
            { level: 'low', count: 10 },
            { level: 'medium', count: 35 },
            { level: 'high', count: 15 },
          ],
        },
        { operation: 'merge', count: 40 },
      ]);
    });

    it('usuario normal: filtra por user_id en ambas consultas', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' } as any;
      const opQb = makeQb({ rawMany: [] });
      const levelQb = makeQb({ rawMany: [] });
      const jobQbSeq = [opQb, levelQb];
      let idx = 0;
      const qbs = new Map<unknown, () => Record<string, unknown>>([
        [CompressionJob, () => jobQbSeq[idx++]],
      ]);
      mockRepos(qbs);

      await getOperationStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect((opQb.__calls as any).where).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
      expect((levelQb.__calls as any).andWhere).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
    });
  });

  describe('getCompressionLevelStats (alias legacy)', () => {
    it('devuelve conteos por nivel', async () => {
      const levelQb = makeQb({
        rawMany: [
          { level: 'low', count: '25' },
          { level: 'medium', count: '50' },
          { level: 'high', count: '25' },
        ],
      });
      const qbs = new Map<unknown, () => Record<string, unknown>>([[CompressionJob, () => levelQb]]);
      mockRepos(qbs);

      await getCompressionLevelStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: [
          { level: 'low', count: 25 },
          { level: 'medium', count: 50 },
          { level: 'high', count: 25 },
        ],
      });
    });

    it('usuario normal: filtra por user_id', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' } as any;
      const levelQb = makeQb({ rawMany: [] });
      const qbs = new Map<unknown, () => Record<string, unknown>>([[CompressionJob, () => levelQb]]);
      mockRepos(qbs);

      await getCompressionLevelStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect((levelQb.__calls as any).where).toContainEqual(['job.user_id = :userId', { userId: 'user-7' }]);
      expect(jsonMock).toHaveBeenCalledWith({ success: true, data: [] });
    });
  });
});
