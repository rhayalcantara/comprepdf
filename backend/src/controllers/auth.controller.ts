import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config/env';
import { logger } from '../utils/logger';
import {
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  InternalServerError,
} from '../utils/errors';
import { UserModel, toSafeUser, BCRYPT_COST } from '../models/user.model';
import { JwtPayload } from '../middlewares/auth.middleware';

/**
 * POST /auth/login  { username, password } -> { token, user }
 *
 * - Rechaza credenciales inválidas (usuario inexistente o contraseña mala) con
 *   401 y el MISMO mensaje, para no revelar qué usernames existen.
 * - Rechaza usuarios `estado='inactivo'` con 403 (solo tras verificar la
 *   contraseña, de modo que el estado no filtra la existencia del usuario).
 * - Firma un JWT `{ sub: user.id, rol: user.rol }` con expiración JWT_EXPIRES_IN.
 * - Actualiza `last_login_at`. Nunca devuelve `passwordHash`.
 *
 * Falla cerrado: sin JWT_SECRET configurada, responde 503 (no se emiten tokens).
 */
export const login = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!config.jwt.secret) {
      logger.error('JWT_SECRET no está configurada: el login está bloqueado.');
      res.status(503).json({
        success: false,
        error: { message: 'Authentication is not configured' },
      });
      return;
    }

    const { username, password } = req.body as {
      username?: string;
      password?: string;
    };

    if (!username || !password) {
      throw new ValidationError('username and password are required');
    }

    const user = await UserModel.findByUsername(username);
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      throw new UnauthorizedError('Invalid credentials');
    }

    if (user.estado === 'inactivo') {
      throw new ForbiddenError('User is inactive');
    }

    const payload: JwtPayload = { sub: user.id, rol: user.rol };
    const token = jwt.sign(payload, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn as jwt.SignOptions['expiresIn'],
    });

    await UserModel.updateLastLogin(user.id);

    res.json({
      success: true,
      data: {
        token,
        user: toSafeUser(user),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * GET /auth/me -> perfil del usuario del token actual (requireAuth).
 * Recarga el usuario de la BD para devolver el perfil fresco y sanitizado.
 */
export const me = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const user = await UserModel.findById(req.user.id);
    if (!user) {
      // El token es válido pero el usuario ya no existe.
      throw new UnauthorizedError('User no longer exists');
    }

    res.json({ success: true, data: { user: toSafeUser(user) } });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /auth/change-password  { currentPassword, newPassword } (requireAuth)
 *
 * Valida la contraseña actual, guarda la nueva (bcrypt) y limpia
 * `must_change_password`.
 */
export const changePassword = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };

    if (!currentPassword || !newPassword) {
      throw new ValidationError('currentPassword and newPassword are required');
    }
    if (newPassword.length < 8) {
      throw new ValidationError('newPassword must be at least 8 characters long');
    }

    const user = await UserModel.findById(req.user.id);
    if (!user) {
      throw new UnauthorizedError('User no longer exists');
    }

    const currentOk = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!currentOk) {
      throw new UnauthorizedError('Current password is incorrect');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const updated = await UserModel.update(user.id, {
      passwordHash,
      mustChangePassword: false,
    });
    if (!updated) {
      throw new InternalServerError('Failed to update password');
    }

    res.json({ success: true, data: { message: 'Password updated' } });
  } catch (error) {
    next(error);
  }
};
