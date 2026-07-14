import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import {
  UserModel,
  toSafeUser,
  BCRYPT_COST,
  UserRole,
  UserStatus,
} from '../models/user.model';
import {
  ValidationError,
  UnauthorizedError,
  NotFoundError,
} from '../utils/errors';

const VALID_ROLES: UserRole[] = ['admin', 'user'];
const VALID_STATUSES: UserStatus[] = ['activo', 'inactivo', 'pendiente'];
const MIN_PASSWORD_LENGTH = 8;

/**
 * Genera una contraseña temporal aleatoria (URL-safe, ~16 chars). Se devuelve
 * UNA sola vez en la respuesta de creación (mismo patrón que la clave del .pfx):
 * no se almacena en claro, solo su hash bcrypt.
 */
function generateTemporaryPassword(): string {
  return crypto.randomBytes(12).toString('base64url');
}

/**
 * GET /users — (admin) lista todos los usuarios como `SafeUser` (sin passwordHash).
 * Respuesta: `{ success, data: { users: SafeUser[] } }`.
 */
export const listUsers = async (
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const users = await UserModel.list();
    res.json({
      success: true,
      data: { users: users.map(toSafeUser) },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * POST /users — (admin) crea un usuario.
 *
 * Body: `{ username, nombre, rol?, email?, password? }`.
 * - `username` obligatorio y único (400 si ya existe).
 * - `rol` opcional (def. 'user'); debe ser 'admin' o 'user'.
 * - `password` opcional: si no viene, se genera una contraseña temporal que se
 *   devuelve UNA sola vez en `data.temporaryPassword`.
 * - Siempre se crea con `must_change_password=true`: la contraseña inicial la
 *   conoce el admin (o es temporal), así que el usuario debe cambiarla al entrar.
 *
 * Respuesta: `{ success, data: { user: SafeUser, temporaryPassword?: string } }`.
 */
export const createUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { username, nombre, rol, email, password } = req.body as {
      username?: string;
      nombre?: string;
      rol?: string;
      email?: string;
      password?: string;
    };

    if (!username || !username.trim()) {
      throw new ValidationError('username is required');
    }
    if (!nombre || !nombre.trim()) {
      throw new ValidationError('nombre is required');
    }
    if (rol !== undefined && !VALID_ROLES.includes(rol as UserRole)) {
      throw new ValidationError("rol must be 'admin' or 'user'");
    }
    if (password !== undefined && password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(
        `password must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      );
    }

    const existing = await UserModel.findByUsername(username.trim());
    if (existing) {
      throw new ValidationError('username already exists');
    }

    // Contraseña provista por el admin o temporal generada (devuelta una vez).
    const generated = password === undefined;
    const plainPassword = generated ? generateTemporaryPassword() : password;
    const passwordHash = await bcrypt.hash(plainPassword, BCRYPT_COST);

    const user = await UserModel.create({
      username: username.trim(),
      nombre: nombre.trim(),
      passwordHash,
      email: email?.trim() || null,
      rol: (rol as UserRole) ?? 'user',
      estado: 'activo',
      authProvider: 'local',
      mustChangePassword: true,
    });

    res.status(201).json({
      success: true,
      data: {
        user: toSafeUser(user),
        // Solo se revela cuando la generó el sistema (no cuando la eligió el admin).
        ...(generated ? { temporaryPassword: plainPassword } : {}),
      },
    });
  } catch (error) {
    next(error);
  }
};

/**
 * PATCH /users/:id — (admin) edita `rol`, `estado`, `nombre`, `email` y/o resetea
 * la contraseña (`newPassword`). NO existe borrado físico: para deshabilitar un
 * usuario se pone `estado='inactivo'`.
 *
 * Si viene `newPassword`: se hashea y se fuerza `must_change_password=true`.
 *
 * Regla anti-lockout: un admin NO puede cambiar su PROPIO `rol` ni su PROPIO
 * `estado` (400). Así el admin que ejecuta la acción sigue siendo admin y activo,
 * y el sistema nunca queda sin ningún administrador por una autoedición. Sí puede
 * editar su nombre/email o resetear su contraseña.
 *
 * Respuesta: `{ success, data: { user: SafeUser } }`.
 */
export const updateUser = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      throw new UnauthorizedError();
    }

    const { id } = req.params;
    const { rol, estado, nombre, email, newPassword } = req.body as {
      rol?: string;
      estado?: string;
      nombre?: string;
      email?: string;
      newPassword?: string;
    };

    if (rol !== undefined && !VALID_ROLES.includes(rol as UserRole)) {
      throw new ValidationError("rol must be 'admin' or 'user'");
    }
    if (estado !== undefined && !VALID_STATUSES.includes(estado as UserStatus)) {
      throw new ValidationError("estado must be 'activo', 'inactivo' or 'pendiente'");
    }
    if (newPassword !== undefined && newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(
        `newPassword must be at least ${MIN_PASSWORD_LENGTH} characters long`,
      );
    }

    // Anti-lockout: el admin no puede alterar su propio rol/estado.
    if (id === req.user.id && (rol !== undefined || estado !== undefined)) {
      throw new ValidationError(
        'You cannot change your own role or status',
      );
    }

    const changes: Parameters<typeof UserModel.update>[1] = {};
    if (rol !== undefined) {
      changes.rol = rol as UserRole;
    }
    if (estado !== undefined) {
      changes.estado = estado as UserStatus;
    }
    if (nombre !== undefined) {
      changes.nombre = nombre.trim();
    }
    if (email !== undefined) {
      changes.email = email.trim() || null;
    }
    if (newPassword !== undefined) {
      changes.passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
      changes.mustChangePassword = true;
    }

    if (Object.keys(changes).length === 0) {
      throw new ValidationError('No fields to update');
    }

    const updated = await UserModel.update(id, changes);
    if (!updated) {
      throw new NotFoundError('User not found');
    }

    res.json({ success: true, data: { user: toSafeUser(updated) } });
  } catch (error) {
    next(error);
  }
};
