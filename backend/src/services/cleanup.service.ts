import { LessThan } from 'typeorm';
import { AppDataSource } from '../config/database';
import { File } from '../models/file.model';
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

      // Limpiar directorios vacíos
      await this.cleanEmptyDirectories();
    } catch (error) {
      logger.error('Cleanup error:', error);
      throw error;
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
