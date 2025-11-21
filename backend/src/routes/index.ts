import { Router } from 'express';
import { compressPdf, getJobStatus, downloadFile, deleteJob } from '../controllers/compress.controller';
import { getGlobalStats, getDailyStats, getRecentJobs, getCompressionLevelStats } from '../controllers/stats.controller';
import { upload } from '../middlewares/upload.middleware';
import { validatePdfFile, validateCompressionOptions } from '../middlewares/validation.middleware';

const router = Router();

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Compression routes
router.post('/compress', upload.single('file'), validatePdfFile, validateCompressionOptions, compressPdf);
router.get('/jobs/:jobId', getJobStatus);
router.get('/jobs/:jobId/download', downloadFile);
router.delete('/jobs/:jobId', deleteJob);

// Statistics routes
router.get('/stats', getGlobalStats);
router.get('/stats/daily', getDailyStats);
router.get('/stats/recent', getRecentJobs);
router.get('/stats/levels', getCompressionLevelStats);

export default router;
