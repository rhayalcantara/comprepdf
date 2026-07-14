import { Router } from 'express';
import { compressPdf, getJobStatus, downloadFile, deleteJob } from '../controllers/compress.controller';
import {
  splitPdf, mergePdfs, signPdf, extractPages,
  rotatePages, protectPdf, unlockPdf,
} from '../controllers/pdf-operation.controller';
import { getGlobalStats, getDailyStats, getRecentJobs, getCompressionLevelStats } from '../controllers/stats.controller';
import { issueCertificate, listCertificates } from '../controllers/certificate.controller';
import { upload, uploadMultiple, uploadSign, enforceSignatureSizeLimit } from '../middlewares/upload.middleware';
import { validatePdfFile, validatePdfFiles, validateCompressionOptions, validateCertificateRequest } from '../middlewares/validation.middleware';
import { requireAdminKey } from '../middlewares/admin-auth.middleware';

const router = Router();

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Compression routes
router.post('/compress', upload.single('file'), validatePdfFile, validateCompressionOptions, compressPdf);

// PDF operation routes (comparten los endpoints genéricos /jobs/:jobId de abajo)
router.post('/pdf/split', upload.single('file'), validatePdfFile, splitPdf);
router.post('/pdf/merge', uploadMultiple.array('files', 50), validatePdfFiles, mergePdfs);
router.post('/pdf/extract', upload.single('file'), validatePdfFile, extractPages);
router.post('/pdf/rotate', upload.single('file'), validatePdfFile, rotatePages);
router.post('/pdf/protect', upload.single('file'), validatePdfFile, protectPdf);
router.post('/pdf/unlock', upload.single('file'), unlockPdf);
router.post(
  '/pdf/sign',
  uploadSign.fields([
    { name: 'file', maxCount: 1 },
    { name: 'cert', maxCount: 1 },
    { name: 'signature', maxCount: 1 },
  ]),
  enforceSignatureSizeLimit,
  signPdf,
);

// Módulo de certificados (CA interna) — SOLO TI, protegido con clave de admin.
// La emisión crea un job 'certificate'; el .pfx se descarga por /jobs/:jobId/download.
router.post('/certificates', requireAdminKey, validateCertificateRequest, issueCertificate);
router.get('/certificates', requireAdminKey, listCertificates);

// Job status/download/delete (genéricos para cualquier operación)
router.get('/jobs/:jobId', getJobStatus);
router.get('/jobs/:jobId/download', downloadFile);
router.delete('/jobs/:jobId', deleteJob);

// Statistics routes
router.get('/stats', getGlobalStats);
router.get('/stats/daily', getDailyStats);
router.get('/stats/recent', getRecentJobs);
router.get('/stats/levels', getCompressionLevelStats);

export default router;
