import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { In } from 'typeorm';
import { AppDataSource } from '../config/database';
import { CompressionJob, CompressionLevel } from '../models/job.model';
import { File } from '../models/file.model';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';
import { sanitizeOutputName } from '../utils/filename';

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
    const result = await jobRepo.delete(jobId);

    if (result.affected === 0) {
      throw new NotFoundError('Job not found');
    }

    res.json({ success: true, message: 'Job deleted successfully' });
  } catch (error) {
    next(error);
  }
};
