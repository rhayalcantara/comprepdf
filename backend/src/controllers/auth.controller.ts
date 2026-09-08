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
 * - `username` acepta el nombre de usuario O el correo (se busca por username
 *   y, si no casa, por email; ambas columnas son case-insensitive).
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

    // El identificador puede ser el username o el correo. Los usuarios no
    // recuerdan cuál de los dos se les asignó al darlos de alta (en QA hay
    // cuentas con el username puesto a mano, con espacios o con el correo
    // entero dentro), y como el 401 es deliberadamente genérico, quien se
    // equivoca de nombre cree que falla la contraseña y la resetea en vano.
    // El username manda: solo se cae al correo si no casa ninguna cuenta.
    const identifier = username.trim();
    const user =
      (await UserModel.findByUsername(identifier)) ??
      (await UserModel.findByEmail(identifier));
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      throw new UnauthorizedError('Invalid credentials');
    }

    // Solo los usuarios 'activo' pueden iniciar sesión. El estado se revela SOLO
    // tras validar la contraseña correctamente, de modo que no filtra la
    // existencia del usuario a quien no conoce su contraseña.
    if (user.estado === 'pendiente') {
      throw new ForbiddenError(
        'Tu cuenta está pendiente de activación por un administrador.',
      );
    }
    if (user.estado !== 'activo') {
      throw new ForbiddenError('Tu cuenta está inactiva.');
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
 * POST /auth/register  { username, nombre, email, password } (PÚBLICO)
 *
 * Autorregistro público restringido al dominio corporativo
 * (`config.allowedSignupDomain`, por defecto `coopaspire.com.do`). El usuario
 * elige su propia contraseña; la cuenta nace `estado='pendiente'` y NO puede
 * iniciar sesión hasta que un admin la pase a `activo`.
 *
 * - No hay auto-login: NO se devuelve token ni el usuario (minimiza información).
 * - Errores de validación son 400 con mensaje en español.
 */
export const register = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { username, nombre, email, password } = req.body as {
      username?: string;
      nombre?: string;
      email?: string;
      password?: string;
    };

    if (!username || !username.trim()) {
      throw new ValidationError('El usuario es obligatorio.');
    }
    if (!nombre || !nombre.trim()) {
      throw new ValidationError('El nombre es obligatorio.');
    }
    if (!email || !email.trim()) {
      throw new ValidationError('El correo es obligatorio.');
    }
    if (!password || password.length < 8) {
      throw new ValidationError('La contraseña debe tener al menos 8 caracteres.');
    }

    const domain = config.allowedSignupDomain;
    const normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail.endsWith(`@${domain.toLowerCase()}`)) {
      throw new ValidationError(
        `El correo debe pertenecer al dominio ${domain}`,
      );
    }

    const cleanUsername = username.trim();
    const existingByUsername = await UserModel.findByUsername(cleanUsername);
    if (existingByUsername) {
      throw new ValidationError('El usuario ya existe');
    }

    const existingByEmail = await UserModel.findByEmail(normalizedEmail);
    if (existingByEmail) {
      throw new ValidationError('El correo ya está registrado');
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    await UserModel.create({
      username: cleanUsername,
      nombre: nombre.trim(),
      email: normalizedEmail,
      passwordHash,
      rol: 'user',
      estado: 'pendiente',
      authProvider: 'local',
      mustChangePassword: false,
    });

    res.status(201).json({
      success: true,
      data: {
        message:
          'Cuenta creada. Un administrador debe activarla antes de que puedas iniciar sesión.',
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
