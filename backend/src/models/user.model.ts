import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/database';
import { config } from '../config/env';
import { logger } from '../utils/logger';

export type UserRole = 'admin' | 'user';
export type UserStatus = 'activo' | 'inactivo' | 'pendiente';
export type AuthProvider = 'local' | 'ad';

/** Coste bcrypt usado en todo el proyecto para hashear contraseñas. */
export const BCRYPT_COST = 12;

/**
 * Usuario del sistema (auth local; `authProvider` deja preparado AD/LDAP para v2).
 *
 * El material sensible es `passwordHash` (bcrypt). Los controllers NUNCA deben
 * devolver ese campo al cliente: usar `toSafeJSON()` para serializar.
 */
@Entity('users')
export class User {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  id!: string;

  @Column({ type: 'varchar', length: 100, unique: true })
  username!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email?: string | null;

  @Column({ type: 'varchar', length: 255 })
  nombre!: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 100 })
  passwordHash!: string;

  @Column({ type: 'enum', enum: ['admin', 'user'], default: 'user' })
  rol!: UserRole;

  @Column({ type: 'enum', enum: ['activo', 'inactivo', 'pendiente'], default: 'activo' })
  estado!: UserStatus;

  @Column({ name: 'auth_provider', type: 'enum', enum: ['local', 'ad'], default: 'local' })
  authProvider!: AuthProvider;

  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword!: boolean;

  @Column({ name: 'last_login_at', type: 'timestamp', nullable: true })
  lastLoginAt?: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}

/** Perfil público del usuario (sin `passwordHash`). Lo que se devuelve al cliente. */
export interface SafeUser {
  id: string;
  username: string;
  email: string | null;
  nombre: string;
  rol: UserRole;
  estado: UserStatus;
  authProvider: AuthProvider;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Serializa un usuario sin el hash de contraseña. */
export function toSafeUser(user: User): SafeUser {
  return {
    id: user.id,
    username: user.username,
    email: user.email ?? null,
    nombre: user.nombre,
    rol: user.rol,
    estado: user.estado,
    authProvider: user.authProvider,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export interface CreateUserInput {
  username: string;
  nombre: string;
  passwordHash: string;
  email?: string | null;
  rol?: UserRole;
  estado?: UserStatus;
  authProvider?: AuthProvider;
  mustChangePassword?: boolean;
}

export interface UpdateUserInput {
  username?: string;
  nombre?: string;
  email?: string | null;
  passwordHash?: string;
  rol?: UserRole;
  estado?: UserStatus;
  mustChangePassword?: boolean;
}

/** Opciones del listado paginado de usuarios (filtros opcionales). */
export interface UserListOptions {
  page: number;
  limit: number;
  rol?: UserRole;
  estado?: UserStatus;
  /** Texto a buscar en username, nombre o email (LIKE, literal). */
  q?: string;
}

/** Página de usuarios: filas, total filtrado y total global de pendientes. */
export interface UserPage {
  users: User[];
  total: number;
  pendingTotal: number;
}

/**
 * Acceso a datos de usuarios. Métodos estáticos sobre el repositorio TypeORM,
 * mismo patrón que usan los controllers con `AppDataSource.getRepository(...)`.
 */
export class UserModel {
  private static repo() {
    return AppDataSource.getRepository(User);
  }

  static findByUsername(username: string): Promise<User | null> {
    return this.repo().findOne({ where: { username } });
  }

  static findByEmail(email: string): Promise<User | null> {
    return this.repo().findOne({ where: { email } });
  }

  static findById(id: string): Promise<User | null> {
    return this.repo().findOne({ where: { id } });
  }

  /** Cuántos administradores ACTIVOS hay (lo consulta el seed inicial). */
  static countActiveAdmins(): Promise<number> {
    return this.repo().count({ where: { rol: 'admin', estado: 'activo' } });
  }

  /**
   * Listado paginado con filtros para la página de administración.
   *
   * Los pendientes van primero (necesitan la acción del admin) y dentro de cada
   * grupo los más recientes; el mismo orden que aplicaba el frontend cuando la
   * tabla era completa, ahora en SQL para que sobreviva a la paginación.
   * `pendingTotal` es el total GLOBAL de pendientes (ignora página y filtros):
   * alimenta la píldora del encabezado.
   */
  static async listPage(opts: UserListOptions): Promise<UserPage> {
    const qb = this.repo().createQueryBuilder('u');
    if (opts.rol) {
      qb.andWhere('u.rol = :rol', { rol: opts.rol });
    }
    if (opts.estado) {
      qb.andWhere('u.estado = :estado', { estado: opts.estado });
    }
    if (opts.q) {
      // % y _ del usuario se tratan como texto literal, no como comodines.
      const q = `%${opts.q.replace(/[\\%_]/g, '\\$&')}%`;
      qb.andWhere('(u.username LIKE :q OR u.nombre LIKE :q OR u.email LIKE :q)', { q });
    }
    const [users, total] = await qb
      .orderBy("CASE WHEN u.estado = 'pendiente' THEN 0 ELSE 1 END", 'ASC')
      .addOrderBy('u.createdAt', 'DESC')
      .skip((opts.page - 1) * opts.limit)
      .take(opts.limit)
      .getManyAndCount();
    const pendingTotal = await this.repo().count({ where: { estado: 'pendiente' } });
    return { users, total, pendingTotal };
  }

  static async create(input: CreateUserInput): Promise<User> {
    const repo = this.repo();
    const user = repo.create({
      id: uuidv4(),
      username: input.username,
      nombre: input.nombre,
      passwordHash: input.passwordHash,
      email: input.email ?? null,
      rol: input.rol ?? 'user',
      estado: input.estado ?? 'activo',
      authProvider: input.authProvider ?? 'local',
      mustChangePassword: input.mustChangePassword ?? false,
    });
    return repo.save(user);
  }

  static async update(id: string, changes: UpdateUserInput): Promise<User | null> {
    const repo = this.repo();
    const user = await repo.findOne({ where: { id } });
    if (!user) {
      return null;
    }
    Object.assign(user, changes);
    return repo.save(user);
  }

  static async updateLastLogin(id: string): Promise<void> {
    await this.repo().update({ id }, { lastLoginAt: new Date() });
  }
}

/**
 * Siembra el primer usuario administrador en el arranque.
 *
 * - Si ya existe un usuario `admin`, no hace nada (idempotente).
 * - Tampoco siembra si ya hay CUALQUIER administrador activo: el username es
 *   editable, así que al admin sembrado se le puede haber renombrado y buscar
 *   'admin' a secas resucitaría un segundo admin con la contraseña del .env.
 * - Si `ADMIN_INITIAL_PASSWORD` no está definida, NO crea nada y avisa por log.
 * - Crea `admin` con rol 'admin', `must_change_password=true` (se fuerza el
 *   cambio en el primer login) y la contraseña temporal hasheada con bcrypt.
 */
export async function seedInitialAdmin(): Promise<void> {
  const existing = await UserModel.findByUsername('admin');
  if (existing) {
    return;
  }

  // Sigue siendo la red de rescate si NO queda ningún admin operativo, pero no
  // duplica al que ya hay solo porque se llame de otra forma.
  if ((await UserModel.countActiveAdmins()) > 0) {
    return;
  }

  const initialPassword = config.adminInitialPassword;
  if (!initialPassword) {
    logger.warn(
      'ADMIN_INITIAL_PASSWORD no está definida y no existe el usuario "admin": ' +
        'no se sembró ningún administrador. Defínela para crear el primer admin.',
    );
    return;
  }

  const passwordHash = await bcrypt.hash(initialPassword, BCRYPT_COST);
  await UserModel.create({
    username: 'admin',
    nombre: 'Administrador',
    passwordHash,
    rol: 'admin',
    estado: 'activo',
    authProvider: 'local',
    mustChangePassword: true,
  });

  logger.info(
    'Usuario "admin" sembrado con la contraseña inicial (must_change_password=true).',
  );
}
