import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { compressPdf, getJobStatus, downloadFile, deleteJob } from '../controllers/compress.controller';
import { listJobs } from '../controllers/jobs.controller';
import { login, register, me, changePassword } from '../controllers/auth.controller';
import { requireAuth, requireRole } from '../middlewares/auth.middleware';
import {
  splitPdf, mergePdfs, signPdf, extractPages,
  rotatePages, protectPdf, unlockPdf,
} from '../controllers/pdf-operation.controller';
import { getOverview, getDailyStats, getRecentJobs, getOperationStats, getCompressionLevelStats } from '../controllers/stats.controller';
import { issueCertificate, listCertificates } from '../controllers/certificate.controller';
import { listUsers, createUser, updateUser } from '../controllers/user.controller';
import { upload, uploadMultiple, uploadSign, enforceSignatureSizeLimit } from '../middlewares/upload.middleware';
import { validatePdfFile, validatePdfFiles, validateCompressionOptions, validateCertificateRequest } from '../middlewares/validation.middleware';

const router = Router();

// ---------------------------------------------------------------------------
// RUTAS PÚBLICAS (sin JWT). Deben ir ANTES del `router.use(requireAuth)` global.
// Estas son la lista DEFINITIVA de rutas públicas del backend:
//   - GET  /health
//   - POST /auth/login
//   - POST /auth/register
// ---------------------------------------------------------------------------

// Health check
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Login: rate-limit endurecido y específico contra fuerza bruta (más estricto
// que el limitador global de app.ts). Cuenta solo intentos fallidos.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 10, // 10 intentos de login por IP y ventana
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    error: { message: 'Too many login attempts, please try again later' },
  },
});
router.post('/auth/login', loginLimiter, login);

// Autorregistro público (dominio corporativo restringido). Rate-limit por IP
// para frenar creación masiva de cuentas: 5 registros / 15 min.
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 registros por IP y ventana
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { message: 'Too many registration attempts, please try again later' },
  },
});
router.post('/auth/register', registerLimiter, register);

// ---------------------------------------------------------------------------
// ENFORCEMENT GLOBAL (Fase 3): a partir de aquí TODA ruta exige un JWT válido.
// Única fuente de verdad del enforcement — las rutas futuras quedan protegidas
// por defecto. Ya NO se repite `requireAuth` por-ruta (sería redundante); solo
// se añade `requireRole('admin')` donde el acceso es exclusivo de administrador.
// ---------------------------------------------------------------------------
router.use(requireAuth);

// Auth (perfil / cambio de contraseña del usuario autenticado)
router.get('/auth/me', me);
router.post('/auth/change-password', changePassword);

// Compression (liga el job al usuario vía user_id = req.user.id)
router.post('/compress', upload.single('file'), validatePdfFile, validateCompressionOptions, compressPdf);

// PDF operation routes (comparten los endpoints genéricos /jobs/:jobId de abajo)
router.post('/pdf/split', upload.single('file'), validatePdfFile, splitPdf);
router.post('/pdf/merge', uploadMultiple.array('files', 50), validatePdfFiles, mergePdfs);
router.post('/pdf/extract', upload.single('file'), validatePdfFile, extractPages);
router.post('/pdf/rotate', upload.single('file'), validatePdfFile, rotatePages);
router.post('/pdf/protect', upload.single('file'), validatePdfFile, protectPdf);
router.post('/pdf/unlock', unlockPdf);
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

// Gestión de usuarios — SOLO admin.
router.get('/users', requireRole('admin'), listUsers);
router.post('/users', requireRole('admin'), createUser);
router.patch('/users/:id', requireRole('admin'), updateUser);

// Módulo de certificados (CA interna) — SOLO admin (antes X-Admin-Key).
// La emisión crea un job 'certificate'; el .pfx se descarga por /jobs/:jobId/download.
router.post('/certificates', requireRole('admin'), validateCertificateRequest, issueCertificate);
router.get('/certificates', requireRole('admin'), listCertificates);

// Historial paginado del usuario ("Mis trabajos"); admin con ?all=true ve todo.
router.get('/jobs', listJobs);

// Job status/download/delete (genéricos para cualquier operación) — con ownership.
router.get('/jobs/:jobId', getJobStatus);
router.get('/jobs/:jobId/download', downloadFile);
router.delete('/jobs/:jobId', deleteJob);

// Statistics routes (user: sus cifras · admin: globales + bloques users/health)
router.get('/stats', getOverview);            // alias de compatibilidad
router.get('/stats/overview', getOverview);
router.get('/stats/daily', getDailyStats);
router.get('/stats/recent', getRecentJobs);
router.get('/stats/operations', getOperationStats);
router.get('/stats/levels', getCompressionLevelStats);  // alias hasta Fase 2

export default router;
