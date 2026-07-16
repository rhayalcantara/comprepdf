import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/env';
import { initializeDatabase } from './config/database';
import { initializeRedis } from './config/redis';
import { cleanupService } from './services/cleanup.service';
import { seedInitialAdmin } from './models/user.model';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware';
import { logger } from './utils/logger';
import routes from './routes';

const app = express();

// Security middlewares
app.use(helmet());
app.use(cors({
  origin: config.nodeEnv === 'development' ? '*' : ['http://localhost:4200'],
  credentials: true,
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

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
