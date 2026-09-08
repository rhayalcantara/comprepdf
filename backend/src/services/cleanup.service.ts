import { LessThan } from 'typeorm';
import { AppDataSource } from '../config/database';
import { File } from '../models/file.model';
import { CompressionJob } from '../models/job.model';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import fs from 'fs/promises';
import path from 'path';

export class CleanupService {
  private intervalId?: NodeJS.Timeout;

  /**
   * Inicia el servicio de limpieza automática
   * Ejecuta cada hora por defecto
   */
  start(intervalMinutes: number = 60): void {
    logger.info(`Cleanup service started (runs every ${intervalMinutes} minutes)`);

    // Ejecutar inmediatamente
    this.cleanup().catch((err) => logger.error('Cleanup failed:', err));

    // Programar ejecución periódica
    this.intervalId = setInterval(() => {
      this.cleanup().catch((err) => logger.error('Cleanup failed:', err));
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Detiene el servicio de limpieza
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info('Cleanup service stopped');
    }
  }

  /**
   * Ejecuta la limpieza de archivos expirados
   */
  async cleanup(): Promise<void> {
    try {
      const fileRepo = AppDataSource.getRepository(File);

      // Buscar archivos expirados
      const expiredFiles = await fileRepo.find({
        where: {
          expiresAt: LessThan(new Date()),
        },
      });

      logger.info(`Found ${expiredFiles.length} expired files to clean`);

      let deletedCount = 0;
      let errorCount = 0;

      for (const file of expiredFiles) {
        try {
          // Eliminar archivo físico
          await fs.unlink(file.filePath);
          logger.debug(`Deleted file: ${file.filePath}`);

          // Eliminar registro de base de datos
          await fileRepo.remove(file);
          deletedCount++;
        } catch (error) {
          errorCount++;
          logger.error(`Failed to delete file ${file.filePath}:`, error);
        }
      }

      logger.info(`Cleanup completed: ${deletedCount} deleted, ${errorCount} errors`);

      // Pasos intermedios del Estudio ya superados
      await this.cleanIntermediateJobs();

      // Limpiar directorios vacíos
      await this.cleanEmptyDirectories();
    } catch (error) {
      logger.error('Cleanup error:', error);
      throw error;
    }
  }

  /**
   * Purga los pasos intermedios de las sesiones del Estudio.
   *
   * Encadenar operaciones multiplica los archivos: una sesión de 5 pasos deja 5
   * entradas y 5 salidas en disco cuando al usuario solo le importa la última.
   * Un job es purgable cuando pertenece a una sesión, YA tiene sucesor (alguien
   * lo tomó como entrada, así que su salida está incorporada al siguiente paso) y
   * lleva parado más de `intermediateTtlMinutes`.
   *
   * El TTL es lo que protege el deshacer: mientras el intermedio viva, la sesión
   * puede volver a él. Por eso la purga NO es inmediata al encadenar.
   */
  private async cleanIntermediateJobs(): Promise<void> {
    const ttlMinutes = config.upload.intermediateTtlMinutes;
    if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
      return;
    }

    try {
      const cutoff = new Date(Date.now() - ttlMinutes * 60 * 1000);
      const jobRepo = AppDataSource.getRepository(CompressionJob);

      const superseded = await jobRepo
        .createQueryBuilder('job')
        .select('job.id', 'id')
        .where('job.session_id IS NOT NULL')
        .andWhere('job.created_at < :cutoff', { cutoff })
        .andWhere(
          'EXISTS (SELECT 1 FROM compression_jobs child WHERE child.parent_job_id = job.id)',
        )
        .getRawMany<{ id: string }>();

      if (superseded.length === 0) {
        return;
      }

      const ids = superseded.map((row) => row.id);
      const fileRepo = AppDataSource.getRepository(File);
      let unlinked = 0;

      for (const jobId of ids) {
        const files = await fileRepo.find({ where: { jobId } });
        for (const file of files) {
          try {
            await fs.unlink(file.filePath);
            unlinked++;
          } catch {
            // El archivo ya no está (expiró o se borró a mano): la fila se va igual.
          }
        }
        // Borrar el job arrastra sus filas de `files` (FK ON DELETE CASCADE) y
        // deja a su hijo con parent_job_id NULL (FK ON DELETE SET NULL).
        await jobRepo.delete(jobId);
      }

      logger.info(
        `Cleanup: purged ${ids.length} superseded studio step(s), ${unlinked} file(s) removed`,
      );
    } catch (error) {
      logger.error('Intermediate job cleanup error:', error);
    }
  }

  /**
   * Limpia directorios vacíos en uploads y outputs
   */
  private async cleanEmptyDirectories(): Promise<void> {
    const dirs = ['./uploads', './outputs'];

    for (const dir of dirs) {
      try {
        const files = await fs.readdir(dir);
        if (files.length === 0 || (files.length === 1 && files[0] === '.gitkeep')) {
          logger.debug(`Directory ${dir} is clean`);
        }
      } catch (error) {
        logger.error(`Error checking directory ${dir}:`, error);
      }
    }
  }

  /**
   * Limpia archivos huérfanos (sin registro en DB)
   */
  async cleanOrphanFiles(): Promise<void> {
    try {
      const fileRepo = AppDataSource.getRepository(File);
      const dirs = ['./uploads', './outputs'];

      for (const dir of dirs) {
        const files = await fs.readdir(dir);

        for (const filename of files) {
          if (filename === '.gitkeep') continue;

          const fullPath = path.join(dir, filename);
          const fileInDb = await fileRepo.findOne({
            where: { filePath: path.resolve(fullPath) },
          });

          if (!fileInDb) {
            await fs.unlink(fullPath);
            logger.info(`Deleted orphan file: ${fullPath}`);
          }
        }
      }
    } catch (error) {
      logger.error('Error cleaning orphan files:', error);
    }
  }
}

export const cleanupService = new CleanupService();
