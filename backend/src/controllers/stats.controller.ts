import { Request, Response, NextFunction } from 'express';
import { AppDataSource } from '../config/database';
import { CompressionStats } from '../models/stats.model';
import { CompressionJob } from '../models/job.model';

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

export const getGlobalStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const statsRepo = AppDataSource.getRepository(CompressionStats);
    const jobRepo = AppDataSource.getRepository(CompressionJob);

    const userId = statsUserId(req);
    // Filtro por dueño en los conteos de jobs (admin: sin filtro = globales).
    const jobWhere = userId ? { userId } : {};

    const [totalJobs, completedJobs, failedJobs] = await Promise.all([
      jobRepo.count({ where: { ...jobWhere } }),
      jobRepo.count({ where: { ...jobWhere, status: 'completed' } }),
      jobRepo.count({ where: { ...jobWhere, status: 'failed' } }),
    ]);

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

    res.json({
      success: true,
      data: {
        totalJobs,
        completedJobs,
        failedJobs,
        pendingJobs: totalJobs - completedJobs - failedJobs,
        successRate: totalJobs > 0 ? Math.round((completedJobs / totalJobs) * 100) : 0,
        avgCompressionRatio: stats?.avgCompressionRatio ? parseFloat(stats.avgCompressionRatio).toFixed(2) : 0,
        avgProcessingTimeMs: stats?.avgProcessingTime ? Math.round(stats.avgProcessingTime) : 0,
        totalOriginalBytes: stats?.totalOriginalSize || 0,
        totalCompressedBytes: stats?.totalCompressedSize || 0,
        totalSpaceSaved: (stats?.totalOriginalSize || 0) - (stats?.totalCompressedSize || 0),
        totalCompressions: parseInt(stats?.totalCompressions || '0', 10),
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getDailyStats = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { days = 7 } = req.query;
    const daysNumber = parseInt(days as string, 10);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysNumber);

    const statsRepo = AppDataSource.getRepository(CompressionStats);
    const userId = statsUserId(req);

    const dailyQb = statsRepo
      .createQueryBuilder('stats')
      .select('DATE(stats.created_at)', 'date')
      .addSelect('COUNT(stats.id)', 'count')
      .addSelect('AVG(stats.compression_ratio)', 'avgRatio')
      .addSelect('AVG(stats.processing_time_ms)', 'avgTime')
      .addSelect('SUM(stats.original_size)', 'totalOriginal')
      .addSelect('SUM(stats.compressed_size)', 'totalCompressed')
      .where('stats.created_at >= :startDate', { startDate });

    if (userId) {
      dailyQb.leftJoin('stats.job', 'job').andWhere('job.user_id = :userId', { userId });
    }

    const dailyStats = await dailyQb
      .groupBy('DATE(stats.created_at)')
      .orderBy('date', 'ASC')
      .getRawMany();

    res.json({
      success: true,
      data: dailyStats.map((stat) => ({
        date: stat.date,
        compressions: parseInt(stat.count, 10),
        avgCompressionRatio: parseFloat(stat.avgRatio).toFixed(2),
        avgProcessingTimeMs: Math.round(stat.avgTime),
        totalOriginalBytes: parseInt(stat.totalOriginal, 10),
        totalCompressedBytes: parseInt(stat.totalCompressed, 10),
        spaceSaved: parseInt(stat.totalOriginal, 10) - parseInt(stat.totalCompressed, 10),
      })),
    });
  } catch (error) {
    next(error);
  }
};

export const getRecentJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { limit = 10 } = req.query;
    const limitNumber = parseInt(limit as string, 10);

    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const userId = statsUserId(req);

    const recentQb = jobRepo
      .createQueryBuilder('job')
      .leftJoinAndSelect('job.files', 'file')
      .orderBy('job.created_at', 'DESC')
      .limit(limitNumber);

    if (userId) {
      recentQb.where('job.user_id = :userId', { userId });
    }

    const recentJobs = await recentQb.getMany();

    res.json({
      success: true,
      data: recentJobs.map((job) => {
        const originalFile = job.files.find((f) => f.fileType === 'original');
        const compressedFile = job.files.find((f) => f.fileType === 'compressed');

        return {
          jobId: job.id,
          status: job.status,
          compressionLevel: job.compressionLevel,
          originalFilename: originalFile?.originalFilename,
          originalSize: originalFile ? Number(originalFile.fileSize) : null,
          compressedSize: compressedFile ? Number(compressedFile.fileSize) : null,
          compressionRatio:
            compressedFile && originalFile
              ? Math.round((1 - Number(compressedFile.fileSize) / Number(originalFile.fileSize)) * 100)
              : null,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        };
      }),
    });
  } catch (error) {
    next(error);
  }
};

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
