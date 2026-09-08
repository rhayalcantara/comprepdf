import { AuthUser } from '../middlewares/auth.middleware';
import { WorkSession } from '../middlewares/source-job.middleware';

/**
 * Aumenta `Express.Request` con el usuario autenticado que adjunta
 * `requireAuth`, y con la sesión de trabajo del Estudio que adjunta
 * `resolveSourceJob`. Este archivo entra en la compilación porque tsconfig
 * incluye `src/**\/*`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      workSession?: WorkSession;
    }
  }
}

export {};
