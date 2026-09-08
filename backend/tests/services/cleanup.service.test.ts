import { CleanupService } from '../../src/services/cleanup.service';
import { AppDataSource } from '../../src/config/database';
import { File } from '../../src/models/file.model';
import { CompressionJob } from '../../src/models/job.model';
import fs from 'fs/promises';

jest.mock('../../src/config/database');
jest.mock('fs/promises');

describe('CleanupService', () => {
  let cleanupService: CleanupService;
  let mockFileRepo: any;
  let mockJobRepo: any;
  /** Ids que devuelve la búsqueda de pasos intermedios superados. */
  let supersededIds: { id: string }[];

  beforeEach(() => {
    cleanupService = new CleanupService();
    mockFileRepo = {
      find: jest.fn(),
      remove: jest.fn(),
      findOne: jest.fn(),
    };

    supersededIds = [];
    // El query builder de `cleanIntermediateJobs` encadena where/andWhere y
    // termina en getRawMany; basta con que cada eslabón se devuelva a sí mismo.
    const qb: any = {
      select: jest.fn(() => qb),
      addSelect: jest.fn(() => qb),
      where: jest.fn(() => qb),
      andWhere: jest.fn(() => qb),
      getRawMany: jest.fn(async () => supersededIds),
    };
    mockJobRepo = {
      createQueryBuilder: jest.fn(() => qb),
      delete: jest.fn(),
    };

    (AppDataSource.getRepository as jest.Mock) = jest
      .fn()
      .mockImplementation((entity: unknown) =>
        entity === CompressionJob ? mockJobRepo : mockFileRepo,
      );
  });

  afterEach(() => {
    jest.clearAllMocks();
    cleanupService.stop();
  });

  describe('cleanup', () => {
    it('should delete expired files', async () => {
      const expiredFiles = [
        {
          id: '1',
          filePath: '/path/to/file1.pdf',
          expiresAt: new Date(Date.now() - 1000),
        },
        {
          id: '2',
          filePath: '/path/to/file2.pdf',
          expiresAt: new Date(Date.now() - 2000),
        },
      ];

      mockFileRepo.find.mockResolvedValue(expiredFiles);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock).mockResolvedValue([]);

      await cleanupService.cleanup();

      expect(mockFileRepo.find).toHaveBeenCalled();
      expect(fs.unlink).toHaveBeenCalledTimes(2);
      expect(mockFileRepo.remove).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully', async () => {
      const expiredFiles = [
        {
          id: '1',
          filePath: '/path/to/file1.pdf',
          expiresAt: new Date(Date.now() - 1000),
        },
      ];

      mockFileRepo.find.mockResolvedValue(expiredFiles);
      (fs.unlink as jest.Mock).mockRejectedValue(new Error('File not found'));
      (fs.readdir as jest.Mock).mockResolvedValue([]);

      await cleanupService.cleanup();

      expect(mockFileRepo.find).toHaveBeenCalled();
      expect(fs.unlink).toHaveBeenCalled();
      // Should not throw error
    });
  });

  // Purga de pasos intermedios del Estudio (jobs de sesión ya superados).
  describe('cleanIntermediateJobs', () => {
    beforeEach(() => {
      mockFileRepo.find.mockResolvedValue([]);
      (fs.unlink as jest.Mock).mockResolvedValue(undefined);
      (fs.readdir as jest.Mock).mockResolvedValue([]);
    });

    it('borra los archivos y la fila de cada paso superado', async () => {
      supersededIds = [{ id: 'step-1' }, { id: 'step-2' }];
      mockFileRepo.find
        .mockResolvedValueOnce([])                                       // expirados
        .mockResolvedValueOnce([{ filePath: '/uploads/in-1.pdf' }])      // archivos de step-1
        .mockResolvedValueOnce([{ filePath: '/outputs/out-2.pdf' }]);    // archivos de step-2

      await cleanupService.cleanup();

      expect(fs.unlink).toHaveBeenCalledWith('/uploads/in-1.pdf');
      expect(fs.unlink).toHaveBeenCalledWith('/outputs/out-2.pdf');
      expect(mockJobRepo.delete).toHaveBeenCalledWith('step-1');
      expect(mockJobRepo.delete).toHaveBeenCalledWith('step-2');
    });

    it('no borra nada cuando ningún paso tiene sucesor', async () => {
      supersededIds = [];

      await cleanupService.cleanup();

      expect(mockJobRepo.delete).not.toHaveBeenCalled();
    });

    it('sigue borrando la fila aunque el archivo ya no esté en disco', async () => {
      supersededIds = [{ id: 'step-1' }];
      mockFileRepo.find
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ filePath: '/uploads/desaparecido.pdf' }]);
      (fs.unlink as jest.Mock).mockRejectedValue(new Error('ENOENT'));

      await cleanupService.cleanup();

      expect(mockJobRepo.delete).toHaveBeenCalledWith('step-1');
    });
  });

  describe('start/stop', () => {
    it('should start and stop cleanup service', () => {
      jest.useFakeTimers();

      cleanupService.start(1);
      expect(cleanupService['intervalId']).toBeDefined();

      cleanupService.stop();
      expect(cleanupService['intervalId']).toBeUndefined();

      jest.useRealTimers();
    });
  });
});
