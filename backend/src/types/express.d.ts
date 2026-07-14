import { AuthUser } from '../middlewares/auth.middleware';

/**
 * Aumenta `Express.Request` con el usuario autenticado que adjunta
 * `requireAuth`. Este archivo entra en la compilación porque tsconfig incluye
 * `src/**\/*`.
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
