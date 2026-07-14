import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import { UserRole } from '../models/user.model';

/**
 * Usuario autenticado que `requireAuth` adjunta a `req.user`. Solo lleva lo que
 * viaja en el JWT; para el perfil completo, recargar con `UserModel.findById`.
 */
export interface AuthUser {
  id: string;
  rol: UserRole;
}

/** Forma del payload del JWT que firma el login. */
export interface JwtPayload {
  sub: string;
  rol: UserRole;
}

/**
 * Verifica el Bearer token y adjunta `req.user = { id, rol }`.
 *
 * Decisión (documentada): confiamos en el token sin recargar el usuario de la
 * BD en cada request. El token es corto (8h por defecto, ver JWT_EXPIRES_IN), de
 * modo que desactivar o cambiar el rol de un usuario surte efecto en como mucho
 * una jornada. La revocación inmediata queda para v2 (refresh tokens en Redis).
 *
 * Falla cerrado: si `JWT_SECRET` no está configurada, rechaza toda petición con
 * 503 (nunca se usa un secreto por defecto inseguro).
 */
export const requireAuth = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const secret = config.jwt.secret;

  if (!secret) {
    logger.error('JWT_SECRET no está configurada: la autenticación está bloqueada.');
    res.status(503).json({
      success: false,
      error: { message: 'Authentication is not configured' },
    });
    return;
  }

  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    res.status(401).json({
      success: false,
      error: { message: 'Missing or malformed Authorization header' },
    });
    return;
  }

  try {
    const payload = jwt.verify(token, secret) as JwtPayload;
    req.user = { id: payload.sub, rol: payload.rol };
    next();
  } catch {
    res.status(401).json({
      success: false,
      error: { message: 'Invalid or expired token' },
    });
  }
};

/**
 * Exige un rol concreto. Usar SIEMPRE después de `requireAuth`.
 * Ejemplo: `router.get('/users', requireAuth, requireRole('admin'), ...)`.
 */
export const requireRole = (role: UserRole) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required' },
      });
      return;
    }

    if (req.user.rol !== role) {
      res.status(403).json({
        success: false,
        error: { message: 'Insufficient permissions' },
      });
      return;
    }

    next();
  };
};
