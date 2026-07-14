-- ComprePDF Database Schema
-- MySQL 8.0

CREATE DATABASE IF NOT EXISTS comprepdf;
USE comprepdf;

-- Tabla de usuarios (auth local; auth_provider preparado para AD/LDAP en v2).
-- El primer admin lo siembra el backend en el arranque a partir de
-- ADMIN_INITIAL_PASSWORD (bcrypt), no en este SQL.
CREATE TABLE IF NOT EXISTS users (
    id            VARCHAR(36) PRIMARY KEY,
    username      VARCHAR(100) UNIQUE NOT NULL,
    email         VARCHAR(255) UNIQUE NULL,
    nombre        VARCHAR(255) NOT NULL,
    password_hash VARCHAR(100) NOT NULL,
    rol           ENUM('admin','user') NOT NULL DEFAULT 'user',
    estado        ENUM('activo','inactivo','pendiente') NOT NULL DEFAULT 'activo',
    auth_provider ENUM('local','ad') NOT NULL DEFAULT 'local',
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMP NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_estado (estado),
    INDEX idx_rol (rol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de trabajos (compresión y operaciones PDF)
CREATE TABLE IF NOT EXISTS compression_jobs (
    id VARCHAR(36) PRIMARY KEY,
    user_id VARCHAR(36) NULL,
    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    operation_type ENUM('compress', 'split', 'merge', 'sign', 'extract', 'rotate', 'protect', 'unlock', 'certificate') NOT NULL DEFAULT 'compress',
    operation_params JSON NULL,
    compression_level ENUM('low', 'medium', 'high', 'custom') NULL,
    custom_dpi INT NULL,
    preserve_metadata BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    started_at TIMESTAMP NULL,
    completed_at TIMESTAMP NULL,
    error_message TEXT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_status (status),
    INDEX idx_operation_type (operation_type),
    INDEX idx_status_created (status, created_at),
    INDEX idx_created_at (created_at),
    INDEX idx_user_created (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de archivos
CREATE TABLE IF NOT EXISTS files (
    id VARCHAR(36) PRIMARY KEY,
    job_id VARCHAR(36) NOT NULL,
    file_type ENUM('original', 'compressed', 'output') NOT NULL,
    filename VARCHAR(255) NOT NULL,
    original_filename VARCHAR(255) NOT NULL,
    file_path VARCHAR(512) NOT NULL,
    file_size BIGINT NOT NULL,
    mime_type VARCHAR(100) DEFAULT 'application/pdf',
    checksum VARCHAR(64) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NULL,
    FOREIGN KEY (job_id) REFERENCES compression_jobs(id) ON DELETE CASCADE,
    INDEX idx_job_id (job_id),
    INDEX idx_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de estadísticas de compresión
CREATE TABLE IF NOT EXISTS compression_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(36) NOT NULL,
    original_size BIGINT NOT NULL,
    compressed_size BIGINT NOT NULL,
    compression_ratio DECIMAL(5,2) NOT NULL,
    processing_time_ms INT NOT NULL,
    pages_count INT NULL,
    images_count INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES compression_jobs(id) ON DELETE CASCADE,
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de estadísticas globales (agregadas diariamente)
CREATE TABLE IF NOT EXISTS daily_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    date DATE UNIQUE NOT NULL,
    total_jobs INT DEFAULT 0,
    successful_jobs INT DEFAULT 0,
    failed_jobs INT DEFAULT 0,
    total_original_bytes BIGINT DEFAULT 0,
    total_compressed_bytes BIGINT DEFAULT 0,
    avg_compression_ratio DECIMAL(5,2) DEFAULT 0,
    avg_processing_time_ms INT DEFAULT 0,
    INDEX idx_date (date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de certificados emitidos (módulo de CA interna "Coopaspire CA")
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
    revoked_at TIMESTAMP NULL,
    revoked_reason VARCHAR(255) NULL,
    emitido_por VARCHAR(100) NULL,
    emitido_por_user_id VARCHAR(36) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (job_id) REFERENCES compression_jobs(id) ON DELETE SET NULL,
    FOREIGN KEY (emitido_por_user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_estado (estado),
    INDEX idx_email (empleado_email),
    INDEX idx_cedula (empleado_cedula),
    INDEX idx_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabla de configuración del sistema
CREATE TABLE IF NOT EXISTS system_config (
    config_key VARCHAR(100) PRIMARY KEY,
    config_value TEXT NOT NULL,
    description VARCHAR(255) NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insertar configuraciones por defecto
INSERT INTO system_config (config_key, config_value, description) VALUES
('max_file_size_mb', '50', 'Tamaño máximo de archivo en MB'),
('file_expiry_hours', '24', 'Horas hasta que expiren los archivos'),
('max_concurrent_jobs', '5', 'Máximo de trabajos concurrentes'),
('default_compression_level', 'medium', 'Nivel de compresión por defecto')
ON DUPLICATE KEY UPDATE config_value = VALUES(config_value);
