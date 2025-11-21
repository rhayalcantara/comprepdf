import { CleanupService } from '../../src/services/cleanup.service';
import { AppDataSource } from '../../src/config/database';
import { File } from '../../src/models/file.model';
import fs from 'fs/promises';

jest.mock('../../src/config/database');
jest.mock('fs/promises');

describe('CleanupService', () => {
  let cleanupService: CleanupService;
  let mockFileRepo: any;

  beforeEach(() => {
    cleanupService = new CleanupService();
    mockFileRepo = {
      find: jest.fn(),
      remove: jest.fn(),
      findOne: jest.fn(),
    };

    (AppDataSource.getRepository as jest.Mock) = jest.fn().mockReturnValue(mockFileRepo);
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

      await cleanupService.cleanup();

      expect(mockFileRepo.find).toHaveBeenCalled();
      expect(fs.unlink).toHaveBeenCalled();
      // Should not throw error
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
