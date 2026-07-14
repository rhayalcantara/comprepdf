import { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../config/database';
import { CompressionStats } from '../models/stats.model';
import { CompressionJob, JobModel, OperationType } from '../models/job.model';
import { File } from '../models/file.model';
import { User } from '../models/user.model';

/**
 * Filtro de ownership para las estadísticas: el admin ve las cifras globales;
 * un usuario normal ve solo las suyas (`user_id = req.user.id`). Devuelve
 * `undefined` (sin filtro) para admin. Requiere `req.user` (montar tras
 * `requireAuth`).
 */
function statsUserId(req: Request): string | undefined {
  if (!req.user || req.user.rol === 'admin') {
    return undefined;
  }
  return req.user.id;
}

/** ¿La petición la hace un administrador? (habilita los bloques users/topUsers). */
function isAdmin(req: Request): boolean {
  return req.user?.rol === 'admin';
}

/**
 * `file_type`s que cuentan como archivo de SALIDA para el uso de almacenamiento:
 * `compressed` (resultado de compresión) y `output` (resultado del resto de
 * operaciones y certificados). `original` es el archivo subido por el usuario y
 * NO cuenta como almacenamiento generado por el servicio.
 */
const OUTPUT_FILE_TYPES = ['compressed', 'output'];

/**
 * GET /stats/overview (alias: GET /stats)
 *
 * Resumen consciente de OPERACIÓN y de ROL. Reemplaza/expande el antiguo
 * `getGlobalStats`: conserva los campos de compresión de nivel superior por
 * compatibilidad con el front actual y añade los nuevos bloques
 * `byOperation`, `compression`, `storage` y (solo admin) `users`/`topUsers`.
 */
export const getOverview = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const statsRepo = AppDataSource.getRepository(CompressionStats);
    const fileRepo = AppDataSource.getRepository(File);

    const userId = statsUserId(req);

    // --- Bloque AGNÓSTICO de operación: conteos por estado desde compression_jobs.
    const statusQb = jobRepo
      .createQueryBuilder('job')
      .select('job.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('job.status');
    if (userId) {
      statusQb.where('job.user_id = :userId', { userId });
    }
    const statusRows = await statusQb.getRawMany();

    const statusCount = (s: string): number =>
      statusRows
        .filter((r) => r.status === s)
        .reduce((acc, r) => acc + parseInt(r.count, 10), 0);

    const completedJobs = statusCount('completed');
    const failedJobs = statusCount('failed');
    const pendingJobs = statusCount('pending');
    const processingJobs = statusCount('processing');
    const totalJobs = statusRows.reduce((acc, r) => acc + parseInt(r.count, 10), 0);

    // --- byOperation: agrupa compression_jobs por operation_type.
    const byOpQb = jobRepo
      .createQueryBuilder('job')
      .select('job.operation_type', 'operation')
      .addSelect('COUNT(*)', 'total')
      .addSelect("SUM(CASE WHEN job.status = 'completed' THEN 1 ELSE 0 END)", 'completed')
      .addSelect("SUM(CASE WHEN job.status = 'failed' THEN 1 ELSE 0 END)", 'failed')
      .groupBy('job.operation_type');
    if (userId) {
      byOpQb.where('job.user_id = :userId', { userId });
    }
    const byOperationRows = await byOpQb.getRawMany();
    const byOperation = byOperationRows.map((r) => ({
      operation: r.operation as OperationType,
      total: parseInt(r.total, 10),
      completed: parseInt(r.completed ?? '0', 10),
      failed: parseInt(r.failed ?? '0', 10),
    }));

    // --- Bloque COMPRESIÓN: métricas propias de compresión desde CompressionStats.
    const statsQb = statsRepo
      .createQueryBuilder('stats')
      .select('AVG(stats.compression_ratio)', 'avgCompressionRatio')
      .addSelect('AVG(stats.processing_time_ms)', 'avgProcessingTime')
      .addSelect('SUM(stats.original_size)', 'totalOriginalSize')
      .addSelect('SUM(stats.compressed_size)', 'totalCompressedSize')
      .addSelect('COUNT(stats.id)', 'totalCompressions');
    if (userId) {
      statsQb.leftJoin('stats.job', 'job').where('job.user_id = :userId', { userId });
    }
    const stats = await statsQb.getRawOne();

    const totalOriginalBytes = Number(stats?.totalOriginalSize || 0);
    const totalCompressedBytes = Number(stats?.totalCompressedSize || 0);
    const avgCompressionRatio = stats?.avgCompressionRatio
      ? parseFloat(stats.avgCompressionRatio).toFixed(2)
      : '0';
    const avgProcessingTimeMs = stats?.avgProcessingTime ? Math.round(stats.avgProcessingTime) : 0;
    const totalSpaceSaved = totalOriginalBytes - totalCompressedBytes;
    const totalCompressions = parseInt(stats?.totalCompressions || '0', 10);

    const compression = {
      avgCompressionRatio,
      avgProcessingTimeMs,
      totalOriginalBytes,
      totalCompressedBytes,
      totalSpaceSaved,
      totalCompressions,
    };

    // --- STORAGE: suma de file_size de los archivos de salida en alcance.
    const storageQb = fileRepo
      .createQueryBuilder('file')
      .select('SUM(file.file_size)', 'outputBytes')
      .where('file.file_type IN (:...types)', { types: OUTPUT_FILE_TYPES });
    if (userId) {
      storageQb.leftJoin('file.job', 'job').andWhere('job.user_id = :userId', { userId });
    }
    const storageRow = await storageQb.getRawOne();
    const storage = { outputBytes: Number(storageRow?.outputBytes || 0) };

    const data: Record<string, unknown> = {
      // Bloque agnóstico de operación.
      totalJobs,
      completedJobs,
      failedJobs,
      pendingJobs,
      processingJobs,
      successRate: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
      // Nuevos bloques operation-aware.
      byOperation,
      compression,
      storage,
      // Compatibilidad con el front actual (se retiran en Fase 2): las métricas
      // de compresión también expuestas a nivel superior.
      avgCompressionRatio,
      avgProcessingTimeMs,
      totalOriginalBytes,
      totalCompressedBytes,
      totalSpaceSaved,
      totalCompressions,
    };

    // --- Bloques SOLO ADMIN: usuarios y top de actividad.
    if (isAdmin(req)) {
      const userRepo = AppDataSource.getRepository(User);
      const userRows = await userRepo
        .createQueryBuilder('u')
        .select('u.estado', 'estado')
        .addSelect('COUNT(*)', 'count')
        .groupBy('u.estado')
        .getRawMany();

      const estadoCount = (e: string): number =>
        userRows
          .filter((r) => r.estado === e)
          .reduce((acc, r) => acc + parseInt(r.count, 10), 0);

      data.users = {
        total: userRows.reduce((acc, r) => acc + parseInt(r.count, 10), 0),
        activos: estadoCount('activo'),
        inactivos: estadoCount('inactivo'),
        pendientes: estadoCount('pendiente'),
      };

      const topRows = await jobRepo
        .createQueryBuilder('job')
        .select('job.user_id', 'userId')
        .addSelect('COUNT(*)', 'jobs')
        .where('job.user_id IS NOT NULL')
        .groupBy('job.user_id')
        .orderBy('jobs', 'DESC')
        .limit(5)
        .getRawMany();

      const usernames = await JobModel.usernamesByIds(topRows.map((r) => r.userId));
      data.topUsers = topRows.map((r) => ({
        userId: r.userId as string,
        username: usernames.get(r.userId) ?? null,
        jobs: parseInt(r.jobs, 10),
      }));
    }

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/** Alias histórico: el nombre antiguo apunta al nuevo handler expandido. */
export const getGlobalStats = getOverview;

/**
 * GET /stats/daily?days=7|30
 *
 * Cuenta TODOS los jobs por día (agrupando `compression_jobs.created_at`), con
 * desglose `byOperation` para permitir el apilado en el front. Mantiene los
 * campos legacy de compresión (`compressions`, `avgCompressionRatio`, …) por
 * compatibilidad con el front actual hasta la Fase 2.
 */
export const getDailyStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { days = 7 } = req.query;
    const parsed = parseInt(days as string, 10);
    const daysNumber = Number.isFinite(parsed) && parsed > 0 ? parsed : 7;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNumber);

    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const statsRepo = AppDataSource.getRepository(CompressionStats);
    const userId = statsUserId(req);

    // Todos los jobs por día y operación.
    const jobQb = jobRepo
      .createQueryBuilder('job')
      .select("DATE_FORMAT(job.created_at, '%Y-%m-%d')", 'date')
      .addSelect('job.operation_type', 'operation')
      .addSelect('COUNT(*)', 'count')
      .where('job.created_at >= :startDate', { startDate })
      .groupBy("DATE_FORMAT(job.created_at, '%Y-%m-%d')")
      .addGroupBy('job.operation_type')
      .orderBy('date', 'ASC');
    if (userId) {
      jobQb.andWhere('job.user_id = :userId', { userId });
    }
    const jobRows = await jobQb.getRawMany();

    // Agregados de compresión por día (campos legacy).
    const compQb = statsRepo
      .createQueryBuilder('stats')
      .select("DATE_FORMAT(stats.created_at, '%Y-%m-%d')", 'date')
      .addSelect('COUNT(stats.id)', 'count')
      .addSelect('AVG(stats.compression_ratio)', 'avgRatio')
      .addSelect('AVG(stats.processing_time_ms)', 'avgTime')
      .addSelect('SUM(stats.original_size)', 'totalOriginal')
      .addSelect('SUM(stats.compressed_size)', 'totalCompressed')
      .where('stats.created_at >= :startDate', { startDate });
    if (userId) {
      compQb.leftJoin('stats.job', 'job').andWhere('job.user_id = :userId', { userId });
    }
    const compRows = await compQb.groupBy("DATE_FORMAT(stats.created_at, '%Y-%m-%d')").getRawMany();

    interface DailyEntry {
      date: string;
      total: number;
      byOperation: Record<string, number>;
      // Campos legacy (compresión).
      compressions: number;
      avgCompressionRatio: string;
      avgProcessingTimeMs: number;
      totalOriginalBytes: number;
      totalCompressedBytes: number;
      spaceSaved: number;
    }

    const map = new Map<string, DailyEntry>();
    const ensure = (rawDate: unknown): DailyEntry => {
      const key = String(rawDate);
      let entry = map.get(key);
      if (!entry) {
        entry = {
          date: key,
          total: 0,
          byOperation: {},
          compressions: 0,
          avgCompressionRatio: '0.00',
          avgProcessingTimeMs: 0,
          totalOriginalBytes: 0,
          totalCompressedBytes: 0,
          spaceSaved: 0,
        };
        map.set(key, entry);
      }
      return entry;
    };

    for (const row of jobRows) {
      const entry = ensure(row.date);
      const n = parseInt(row.count, 10);
      entry.byOperation[row.operation] = (entry.byOperation[row.operation] ?? 0) + n;
      entry.total += n;
    }

    for (const row of compRows) {
      const entry = ensure(row.date);
      const orig = parseInt(row.totalOriginal ?? '0', 10);
      const comp = parseInt(row.totalCompressed ?? '0', 10);
      entry.compressions = parseInt(row.count ?? '0', 10);
      entry.avgCompressionRatio = row.avgRatio ? parseFloat(row.avgRatio).toFixed(2) : '0.00';
      entry.avgProcessingTimeMs = row.avgTime ? Math.round(row.avgTime) : 0;
      entry.totalOriginalBytes = orig;
      entry.totalCompressedBytes = comp;
      entry.spaceSaved = orig - comp;
    }

    const data = Array.from(map.values()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /stats/recent?limit=N
 *
 * Últimos jobs de CUALQUIER operación. Añade `operationType` a cada item y, solo
 * en modo admin, el `username` del propietario (batch lookup como en
 * `jobs.controller`). Las columnas de compresión quedan opcionales (null para
 * las operaciones que no son compresión).
 */
export const getRecentJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { limit = 10 } = req.query;
    const limitNumber = parseInt(limit as string, 10);

    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const userId = statsUserId(req);
    const admin = isAdmin(req);

    const recentQb = jobRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.files', 'file')
      .orderBy('job.created_at', 'DESC')
      .limit(limitNumber);

    if (userId) {
      recentQb.where('job.user_id = :userId', { userId });
    }

    const recentJobs = await recentQb.getMany();

    // Solo admin: resolver username por lote (evita N+1).
    const usernames = admin
      ? await JobModel.usernamesByIds(recentJobs.map((j) => j.userId))
      : new Map<string, string>();

    res.json({
      success: true,
      data: recentJobs.map((job) => {
        const originalFile = job.files.find((f) => f.fileType === 'original');
        const compressedFile = job.files.find((f) => f.fileType === 'compressed');

        const item: Record<string, unknown> = {
          jobId: job.id,
          status: job.status,
          operationType: job.operationType,
          compressionLevel: job.compressionLevel ?? null,
          originalFilename: originalFile?.originalFilename ?? null,
          originalSize: originalFile ? Number(originalFile.fileSize) : null,
          compressedSize: compressedFile ? Number(compressedFile.fileSize) : null,
          compressionRatio:
            compressedFile && originalFile
              ? Math.round((1 - Number(compressedFile.fileSize) / Number(originalFile.fileSize)) * 100)
              : null,
          createdAt: job.createdAt,
          completedAt: job.completedAt ?? null,
        };

        if (admin) {
          item.username = job.userId ? usernames.get(job.userId) ?? null : null;
        }

        return item;
      }),
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /stats/operations
 *
 * Conteo por `operation_type`. El item de `compress` lleva anidado el desglose
 * `compressionLevels: [{ level, count }]`. Sustituye conceptualmente a
 * `/stats/levels` (que se conserva como alias hasta la Fase 2).
 */
export const getOperationStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const userId = statsUserId(req);

    const opQb = jobRepo
      .createQueryBuilder('job')
      .select('job.operation_type', 'operation')
      .addSelect('COUNT(*)', 'count')
      .groupBy('job.operation_type');
    if (userId) {
      opQb.where('job.user_id = :userId', { userId });
    }
    const opRows = await opQb.getRawMany();

    // Desglose por nivel de compresión (solo operación compress).
    const levelQb = jobRepo
      .createQueryBuilder('job')
      .select('job.compression_level', 'level')
      .addSelect('COUNT(*)', 'count')
      .where("job.operation_type = 'compress'")
      .groupBy('job.compression_level');
    if (userId) {
      levelQb.andWhere('job.user_id = :userId', { userId });
    }
    const levelRows = await levelQb.getRawMany();
    const compressionLevels = levelRows.map((r) => ({
      level: r.level,
      count: parseInt(r.count, 10),
    }));

    const data = opRows.map((r) => {
      const item: Record<string, unknown> = {
        operation: r.operation,
        count: parseInt(r.count, 10),
      };
      if (r.operation === 'compress') {
        item.compressionLevels = compressionLevels;
      }
      return item;
    });

    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /stats/levels — conteo de jobs por nivel de compresión.
 *
 * Mantenido como alias/compat: el front lo dejará de usar en la Fase 2 en favor
 * de `/stats/operations` (que anida este desglose dentro de `compress`).
 */
export const getCompressionLevelStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const userId = statsUserId(req);

    const levelQb = jobRepo
      .createQueryBuilder('job')
      .select('job.compression_level', 'level')
      .addSelect('COUNT(*)', 'count')
      .groupBy('job.compression_level');

    if (userId) {
      levelQb.where('job.user_id = :userId', { userId });
    }

    const levelStats = await levelQb.getRawMany();

    res.json({
      success: true,
      data: levelStats.map((stat) => ({
        level: stat.level,
        count: parseInt(stat.count, 10),
      })),
    });
  } catch (error) {
    next(error);
  }
};
