-- Migración 002: Módulo de certificados (CA interna "Coopaspire CA")
-- Aplicar sobre instancias existentes. Uso:
--   mysql -u root -p comprepdf < database/migrations/002_certificates.sql

USE comprepdf;

-- 1. compression_jobs: añadir 'certificate' al enum de operaciones.
ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
    ENUM('compress', 'split', 'merge', 'sign', 'extract', 'rotate', 'protect', 'unlock', 'certificate')
    NOT NULL DEFAULT 'compress';

-- 2. Registro de certificados emitidos (auditoría y base para revocación en v1.1).
CREATE TABLE IF NOT EXISTS certificados_emitidos (
    serial VARCHAR(64) PRIMARY KEY,                 -- número de serie del cert (hex)
    job_id VARCHAR(36) NULL,                         -- job de emisión que lo generó
    empleado_nombre VARCHAR(255) NOT NULL,
    empleado_cedula VARCHAR(40) NULL,
    empleado_email VARCHAR(255) NULL,
    departamento VARCHAR(255) NULL,
    not_before TIMESTAMP NULL,
    not_after TIMESTAMP NULL,
    estado ENUM('activo', 'revocado') NOT NULL DEFAULT 'activo',
    revoked_at TIMESTAMP NULL,                        -- v1.1
    revoked_reason VARCHAR(255) NULL,                 -- v1.1
    emitido_por VARCHAR(100) NULL,                    -- quién lo emitió (TI)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES compression_jobs(id) ON DELETE SET NULL,
    INDEX idx_estado (estado),
    INDEX idx_email (empleado_email),
    INDEX idx_cedula (empleado_cedula),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
