-- 005_pdf_forms.sql — Gestor de formularios PDF rellenables (AcroForm)
--
-- Integra el proyecto `gestor-formularios-pdf` en ComprePDF:
--   1) La GENERACIÓN del PDF reutiliza el patrón job/poller: se añade la
--      operación `form_generate` (a diferencia del resto, NO tiene archivo de
--      entrada — el worker genera el PDF desde la definición en operation_params).
--   2) Las DEFINICIONES de formulario son persistentes (borradores editables) en
--      la nueva tabla `pdf_forms`, con dueño (mismo modelo de ownership que jobs).

-- 1) Nueva operación de worker (sin archivo de entrada).
ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
  ENUM('compress','split','merge','sign','extract','rotate','protect','unlock','certificate','form_generate')
  NOT NULL DEFAULT 'compress';

-- 2) Definiciones de formulario persistentes (borradores reutilizables).
CREATE TABLE IF NOT EXISTS pdf_forms (
    id         VARCHAR(36) PRIMARY KEY,
    user_id    VARCHAR(36) NULL,            -- dueño; NULL = huérfano (solo admin)
    name       VARCHAR(120) NOT NULL,
    payload    JSON NOT NULL,               -- FormDefinition completa (snake_case)
    version    INT NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    INDEX idx_user_updated (user_id, updated_at),
    INDEX idx_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
