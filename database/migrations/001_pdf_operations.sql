-- Migración 001: Operaciones PDF (split, merge, sign, extract, rotate, protect, unlock)
-- Aplicar sobre instancias existentes creadas con el schema.sql original (solo compresión).
-- Uso: mysql -u root -p comprepdf < database/migrations/001_pdf_operations.sql

USE comprepdf;

-- 1. compression_jobs: tipo de operación + parámetros genéricos
ALTER TABLE compression_jobs
  ADD COLUMN operation_type ENUM('compress', 'split', 'merge', 'sign', 'extract', 'rotate', 'protect', 'unlock')
    NOT NULL DEFAULT 'compress' AFTER status,
  ADD COLUMN operation_params JSON NULL AFTER operation_type;

-- compression_level pasa a ser opcional (las operaciones no-compresión no lo usan)
ALTER TABLE compression_jobs
  MODIFY COLUMN compression_level ENUM('low', 'medium', 'high', 'custom') NULL;

-- Índices para el polling del worker (status + created_at) y filtrado por operación
ALTER TABLE compression_jobs
  ADD INDEX idx_operation_type (operation_type),
  ADD INDEX idx_status_created (status, created_at);

-- Normalizar filas existentes
UPDATE compression_jobs SET operation_type = 'compress' WHERE operation_type IS NULL;

-- 2. files: nuevo tipo de salida genérico para operaciones PDF
ALTER TABLE files
  MODIFY COLUMN file_type ENUM('original', 'compressed', 'output') NOT NULL;
