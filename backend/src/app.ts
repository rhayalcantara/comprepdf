import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { initializeDatabase } from './config/database';
import { initializeRedis } from './config/redis';
import { cleanupService } from './services/cleanup.service';
import { seedInitialAdmin } from './models/user.model';
import { AppDataSource } from './config/database';
import { runMigrations } from './services/migration.service';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { logger } from './utils/logger';
import routes from './routes';

const app = express();

// Security middlewares
app.use(helmet());
app.use(cors({
  // En producción el frontend (nginx) proxea /api en el MISMO origen, así que
  // CORS no interviene; CORS_ORIGINS (lista separada por comas) cubre el caso
  // de servir el frontend desde otro host/puerto (p. ej. QA nativo :8090).
  origin: config.nodeEnv === 'development' ? '*' : config.corsOrigins,
  credentials: true,
}));

// Rate limiting.
//
// El sondeo del estado de un job (GET /jobs/:id) NO puede compartir cupo con el
// resto: es el latido normal de cualquier operación asíncrona y consume una
// petición cada segundo y pico mientras el worker trabaja. Con el tope general
// de 100/15min, una sesión del Estudio (varias operaciones encadenadas) agotaba
// la cuota y el usuario acababa viendo "Too many requests" a mitad de su
// trabajo. Se le da un limitador propio y holgado: sigue habiendo techo contra
// un bucle desbocado, pero no compite con las operaciones reales.
const POLL_PATH = /^\/api\/v1\/jobs\/[^/]+$/;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

const pollLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1500, // ~1 sondeo/s sostenido durante 25 min
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { message: 'Too many status requests, please slow down' },
  },
});

// El reparto se hace aquí y no con `app.use(ruta, …)` porque el montaje por
// prefijo de Express no distingue `/jobs/:id` de `/jobs/:id/download`.
app.use((req, res, next) => {
  const isPoll = req.method === 'GET' && POLL_PATH.test(req.path);
  return isPoll ? pollLimiter(req, res, next) : limiter(req, res, next);
});

// Body parsing. El límite por defecto de express.json son 100kb, insuficiente
// para las definiciones de formulario: el logo y los iconos viajan dentro del
// JSON como data URI. El tamaño de cada imagen se acota aparte, en
// `utils/form-definition.ts`; esto es solo el techo del body.
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Routes
app.use('/api/v1', routes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

const startServer = async (): Promise<void> => {
  try {
    await initializeDatabase();

    // Migraciones SQL pendientes ANTES de abrir el puerto: en producción el
    // despliegue (Puente) no ejecuta SQL, así que migra el propio backend. Si
    // fallan, no se arranca (ver services/migration.service.ts).
    await runMigrations((sql, params) => AppDataSource.query(sql, params as any[]));

    // Siembra del primer admin (idempotente; no hace nada si ya existe o si
    // ADMIN_INITIAL_PASSWORD no está definida).
    try {
      await seedInitialAdmin();
    } catch (err) {
      logger.warn('No se pudo sembrar el usuario admin inicial:', err);
    }

    // Redis es opcional (ya no se usa como broker tras migrar a polling en MySQL).
    // No debe impedir el arranque si no está disponible.
    try {
      await initializeRedis();
    } catch (err) {
      logger.warn('Redis no disponible; continuando sin caché Redis (no requerido).');
    }

    // Iniciar servicio de limpieza (ejecuta cada hora)
    cleanupService.start(60);

    app.listen(config.port, () => {
      logger.info(`Server running on port ${config.port} in ${config.nodeEnv} mode`);
    });

    // Cleanup graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received, shutting down gracefully');
      cleanupService.stop();
      process.exit(0);
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
};

startServer();

export default app;
