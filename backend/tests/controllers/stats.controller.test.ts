import { Request, Response, NextFunction } from 'express';
import { getGlobalStats, getDailyStats, getRecentJobs, getCompressionLevelStats } from '../../src/controllers/stats.controller';
import { AppDataSource } from '../../src/config/database';

jest.mock('../../src/config/database');

describe('Stats Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnThis();

    // Por defecto un admin: toma el camino "globales" (sin filtro por usuario),
    // que es el comportamiento histórico verificado por estos tests.
    mockRequest = {
      query: {},
      params: {},
      user: { id: 'admin-1', rol: 'admin' }
    };

    mockResponse = {
      json: jsonMock,
      status: statusMock
    };

    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getGlobalStats', () => {
    it('should return global statistics successfully', async () => {
      const mockStatsRepo = {
        count: jest.fn()
          .mockResolvedValueOnce(100) // totalJobs
          .mockResolvedValueOnce(85)  // completedJobs
          .mockResolvedValueOnce(5),  // failedJobs
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          getRawOne: jest.fn().mockResolvedValue({
            avgCompressionRatio: '65.50',
            avgProcessingTime: 12500,
            totalOriginalSize: 1000000000,
            totalCompressedSize: 350000000,
            totalCompressions: '85'
          })
        })
      };

      const mockJobRepo = {
        count: jest.fn()
          .mockResolvedValueOnce(100)
          .mockResolvedValueOnce(85)
          .mockResolvedValueOnce(5)
      };

      (AppDataSource.getRepository as jest.Mock)
        .mockReturnValueOnce(mockStatsRepo)
        .mockReturnValueOnce(mockJobRepo);

      await getGlobalStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({
          totalJobs: 100,
          completedJobs: 85,
          failedJobs: 5,
          pendingJobs: 10,
          successRate: 85,
          avgCompressionRatio: '65.50',
          avgProcessingTimeMs: 12500,
          totalCompressions: 85
        })
      });
    });

    it('should handle errors', async () => {
      const error = new Error('Database error');

      (AppDataSource.getRepository as jest.Mock).mockImplementation(() => {
        throw error;
      });

      await getGlobalStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });

  describe('getDailyStats', () => {
    it('should return daily statistics for specified days', async () => {
      mockRequest.query = { days: '7' };

      const mockDailyStats = [
        {
          date: '2025-11-21',
          count: '10',
          avgRatio: '65.50',
          avgTime: '12500',
          totalOriginal: '100000000',
          totalCompressed: '35000000'
        }
      ];

      const mockStatsRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue(mockDailyStats)
        })
      };

      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockStatsRepo);

      await getDailyStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            date: '2025-11-21',
            compressions: 10,
            avgCompressionRatio: '65.50'
          })
        ])
      });
    });

    it('should use default days value when not specified', async () => {
      mockRequest.query = {};

      const mockStatsRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          where: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([])
        })
      };

      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockStatsRepo);

      await getDailyStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: []
      });
    });
  });

  describe('getRecentJobs', () => {
    it('should return recent jobs with compression details', async () => {
      mockRequest.query = { limit: '5' };

      const mockJobs = [
        {
          id: 'job-1',
          status: 'completed',
          compressionLevel: 'medium',
          createdAt: new Date('2025-11-21'),
          completedAt: new Date('2025-11-21'),
          files: [
            {
              fileType: 'original',
              originalFilename: 'test.pdf',
              fileSize: BigInt(1000000)
            },
            {
              fileType: 'compressed',
              originalFilename: 'test.pdf',
              fileSize: BigInt(350000)
            }
          ]
        }
      ];

      const mockJobRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          leftJoinAndSelect: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          getMany: jest.fn().mockResolvedValue(mockJobs)
        })
      };

      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockJobRepo);

      await getRecentJobs(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: expect.arrayContaining([
          expect.objectContaining({
            jobId: 'job-1',
            status: 'completed',
            compressionLevel: 'medium',
            originalFilename: 'test.pdf',
            originalSize: 1000000,
            compressedSize: 350000,
            compressionRatio: 65
          })
        ])
      });
    });
  });

  describe('getCompressionLevelStats', () => {
    it('should return job counts grouped by compression level', async () => {
      const mockLevelStats = [
        { level: 'low', count: '25' },
        { level: 'medium', count: '50' },
        { level: 'high', count: '25' }
      ];

      const mockJobRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue(mockLevelStats)
        })
      };

      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockJobRepo);

      await getCompressionLevelStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: [
          { level: 'low', count: 25 },
          { level: 'medium', count: 50 },
          { level: 'high', count: 25 }
        ]
      });
    });

    it('should handle empty results', async () => {
      const mockJobRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          getRawMany: jest.fn().mockResolvedValue([])
        })
      };

      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockJobRepo);

      await getCompressionLevelStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith({
        success: true,
        data: []
      });
    });
  });

  describe('filtrado por usuario (no admin)', () => {
    it('getGlobalStats filtra los conteos por user_id y JOINea stats a job', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' };

      const leftJoinMock = jest.fn().mockReturnThis();
      const whereMock = jest.fn().mockReturnThis();
      const mockStatsRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          leftJoin: leftJoinMock,
          where: whereMock,
          getRawOne: jest.fn().mockResolvedValue({
            avgCompressionRatio: '50.00',
            avgProcessingTime: 1000,
            totalOriginalSize: 200,
            totalCompressedSize: 100,
            totalCompressions: '3',
          }),
        }),
      };
      const countMock = jest.fn().mockResolvedValue(3);
      const mockJobRepo = { count: countMock };

      (AppDataSource.getRepository as jest.Mock)
        .mockReturnValueOnce(mockStatsRepo)
        .mockReturnValueOnce(mockJobRepo);

      await getGlobalStats(mockRequest as Request, mockResponse as Response, mockNext);

      // Los tres conteos llevan el filtro por dueño.
      expect(countMock).toHaveBeenCalledWith({ where: { userId: 'user-7' } });
      expect(countMock).toHaveBeenCalledWith({ where: { userId: 'user-7', status: 'completed' } });
      expect(countMock).toHaveBeenCalledWith({ where: { userId: 'user-7', status: 'failed' } });
      // El agregado de stats se restringe con un JOIN a job.
      expect(leftJoinMock).toHaveBeenCalledWith('stats.job', 'job');
      expect(whereMock).toHaveBeenCalledWith('job.user_id = :userId', { userId: 'user-7' });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('getRecentJobs filtra por user_id cuando no es admin', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' };
      mockRequest.query = { limit: '5' };

      const whereMock = jest.fn().mockReturnThis();
      const mockJobRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          leftJoinAndSelect: jest.fn().mockReturnThis(),
          orderBy: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          where: whereMock,
          getMany: jest.fn().mockResolvedValue([]),
        }),
      };
      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockJobRepo);

      await getRecentJobs(mockRequest as Request, mockResponse as Response, mockNext);

      expect(whereMock).toHaveBeenCalledWith('job.user_id = :userId', { userId: 'user-7' });
      expect(jsonMock).toHaveBeenCalledWith({ success: true, data: [] });
    });

    it('getCompressionLevelStats filtra por user_id cuando no es admin', async () => {
      mockRequest.user = { id: 'user-7', rol: 'user' };

      const whereMock = jest.fn().mockReturnThis();
      const mockJobRepo = {
        createQueryBuilder: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnThis(),
          addSelect: jest.fn().mockReturnThis(),
          groupBy: jest.fn().mockReturnThis(),
          where: whereMock,
          getRawMany: jest.fn().mockResolvedValue([]),
        }),
      };
      (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockJobRepo);

      await getCompressionLevelStats(mockRequest as Request, mockResponse as Response, mockNext);

      expect(whereMock).toHaveBeenCalledWith('job.user_id = :userId', { userId: 'user-7' });
      expect(jsonMock).toHaveBeenCalledWith({ success: true, data: [] });
    });
  });
});
