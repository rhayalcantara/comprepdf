-- Migración 003: Usuarios y trazabilidad de acciones (auth + ownership de jobs)
-- Aplicar sobre instancias existentes. Uso:
--   mysql -u root -p comprepdf < database/migrations/003_users.sql
--
-- Nota sobre el primer admin: NO se siembra aquí con una contraseña en texto
-- plano. El backend, en su arranque (models/user.model.ts -> seedInitialAdmin),
-- crea el usuario `admin` con el hash bcrypt de ADMIN_INITIAL_PASSWORD y
-- must_change_password=TRUE si la tabla no tiene todavía ese usuario. Así el
-- hash nunca vive en el SQL y la contraseña temporal solo existe en el .env del
-- servidor.

USE comprepdf;

-- 1. Tabla de usuarios (auth local; auth_provider preparado para AD/LDAP en v2).
CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(36) PRIMARY KEY,
    username      VARCHAR(100) UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE NULL,
    nombre        VARCHAR(255) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    rol           ENUM('admin','user') NOT NULL DEFAULT 'user',
    estado        ENUM('activo','inactivo') NOT NULL DEFAULT 'activo',
    auth_provider ENUM('local','ad') NOT NULL DEFAULT 'local',  -- preparado para v2
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMP NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_estado (estado),
    INDEX idx_rol (rol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. compression_jobs: ligar cada job al usuario que lo creó.
--    Nullable + ON DELETE SET NULL: los jobs viejos quedan huérfanos (visibles
--    solo para admin) y borrar un usuario no borra su historial.
ALTER TABLE compression_jobs
    ADD COLUMN user_id VARCHAR(36) NULL AFTER id,
    ADD CONSTRAINT fk_jobs_user FOREIGN KEY (user_id)
        REFERENCES users(id) ON DELETE SET NULL,
    ADD INDEX idx_user_created (user_id, created_at);

-- 3. certificados_emitidos: auditoría de quién emitió (además del texto libre
--    'emitido_por' que ya existía).
ALTER TABLE certificados_emitidos
    ADD COLUMN emitido_por_user_id VARCHAR(36) NULL AFTER emitido_por,
    ADD CONSTRAINT fk_cert_user FOREIGN KEY (emitido_por_user_id)
        REFERENCES users(id) ON DELETE SET NULL;
