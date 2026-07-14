import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { In } from 'typeorm';
import { AppDataSource } from '../config/database';
import { CompressionJob, CompressionLevel } from '../models/job.model';
import { File } from '../models/file.model';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError, UnauthorizedError } from '../utils/errors';
import { sanitizeOutputName } from '../utils/filename';

/**
 * Autorización por ownership de un job. Reglas (ver PLAN_USUARIOS §5):
 * - admin: ve/acciona cualquier job.
 * - usuario normal: solo sus propios jobs.
 * - un job de otro usuario o huérfano (`userId` NULL) responde **404** (no 403)
 *   para no revelar la existencia de trabajos ajenos.
 * Debe usarse SIEMPRE tras `requireAuth` (garantiza `req.user`).
 */
function assertJobVisible(job: { userId?: string | null }, req: Request): void {
  const user = req.user;
  if (!user) {
    throw new UnauthorizedError();
  }
  if (user.rol === 'admin') {
    return;
  }
  if (!job.userId || job.userId !== user.id) {
    throw new NotFoundError('Job not found');
  }
}

export const compressPdf = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.file) {
      throw new ValidationError('No file uploaded');
    }

    const { compressionLevel = 'medium', preserveMetadata = true, customDpi } = req.body;
    const outputName = sanitizeOutputName(req.body.outputName);
    const jobId = uuidv4();
    const fileId = uuidv4();

    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const fileRepo = AppDataSource.getRepository(File);

    // Create job
    const job = jobRepo.create({
      id: jobId,
      userId: req.user?.id ?? null,
      status: 'pending',
      operationType: 'compress',
      operationParams: outputName ? { output_name: outputName } : undefined,
      compressionLevel: compressionLevel as CompressionLevel,
      preserveMetadata: preserveMetadata === 'true' || preserveMetadata === true,
      customDpi: customDpi ? parseInt(customDpi, 10) : undefined,
    });
    await jobRepo.save(job);

    // Create file record
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + config.upload.fileExpiryHours);

    const file = fileRepo.create({
      id: fileId,
      jobId,
      fileType: 'original',
      filename: req.file.filename,
      originalFilename: req.file.originalname,
      filePath: path.resolve(req.file.path),
      fileSize: req.file.size,
      mimeType: req.file.mimetype,
      expiresAt,
    });
    await fileRepo.save(file);

    // El worker (poller) recoge el job pendiente directamente desde MySQL.
    logger.info(`Job ${jobId} created for file ${req.file.originalname}`);

    res.status(201).json({
      success: true,
      data: {
        jobId,
        status: 'pending',
        originalFilename: req.file.originalname,
        originalSize: req.file.size,
        compressionLevel,
        createdAt: job.createdAt,
        estimatedTime: Math.ceil(req.file.size / (1024 * 1024)) * 3,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const getJobStatus = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { jobId } = req.params;

    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const job = await jobRepo.findOne({
      where: { id: jobId },
      relations: ['files'],
    });

    if (!job) {
      throw new NotFoundError('Job not found');
    }

    assertJobVisible(job, req);

    const originalFile = job.files.find(f => f.fileType === 'original');
    // El archivo de resultado es 'compressed' (compresión) o 'output' (otras operaciones)
    const resultFile = job.files.find(f => f.fileType === 'compressed' || f.fileType === 'output');

    res.json({
      success: true,
      data: {
        jobId: job.id,
        status: job.status,
        operationType: job.operationType,
        originalFilename: originalFile?.originalFilename,
        originalSize: originalFile ? Number(originalFile.fileSize) : null,
        outputFilename: resultFile?.originalFilename,
        compressedSize: resultFile ? Number(resultFile.fileSize) : null,
        compressionRatio: resultFile && originalFile && job.operationType === 'compress'
          ? Math.round((1 - Number(resultFile.fileSize) / Number(originalFile.fileSize)) * 100)
          : null,
        downloadUrl: resultFile ? `/api/v1/jobs/${jobId}/download` : null,
        expiresAt: resultFile?.expiresAt,
        createdAt: job.createdAt,
        completedAt: job.completedAt,
        errorMessage: job.errorMessage,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const downloadFile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { jobId } = req.params;

    // Cargar el job primero para aplicar ownership antes de exponer el archivo.
    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const job = await jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundError('Job not found');
    }
    assertJobVisible(job, req);

    const fileRepo = AppDataSource.getRepository(File);
    const file = await fileRepo.findOne({
      where: { jobId, fileType: In(['compressed', 'output']) },
    });

    if (!file) {
      throw new NotFoundError('Output file not found');
    }

    // Para compresión conservamos el prefijo histórico; para el resto usamos el
    // nombre amigable ya almacenado por el worker en original_filename.
    const downloadName = file.fileType === 'compressed'
      ? `compressed_${file.originalFilename}`
      : file.originalFilename;

    res.download(file.filePath, downloadName);
  } catch (error) {
    next(error);
  }
};

export const deleteJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { jobId } = req.params;

    const jobRepo = AppDataSource.getRepository(CompressionJob);
    const job = await jobRepo.findOne({ where: { id: jobId } });
    if (!job) {
      throw new NotFoundError('Job not found');
    }
    assertJobVisible(job, req);

    await jobRepo.delete(jobId);

    res.json({ success: true, message: 'Job deleted successfully' });
  } catch (error) {
    next(error);
  }
};
