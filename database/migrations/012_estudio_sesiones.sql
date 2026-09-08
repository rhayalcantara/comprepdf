-- 012_estudio_sesiones.sql — Encadenar operaciones sin pasar por el disco del usuario
--
-- Fase 0 del PLAN_ESTUDIO_PDF: un job puede tomar como entrada la SALIDA de otro
-- job (`parent_job_id`) en lugar de un archivo subido, y varios jobs encadenados
-- se agrupan bajo una misma sesión de trabajo (`session_id`).
--
-- Para qué sirve cada columna:
--   * parent_job_id — de qué job salió la entrada de este. Permite reconstruir la
--     cadena y detectar jobs "superados" (los que ya tienen sucesor), que son los
--     candidatos a purga anticipada.
--   * session_id — agrupa la cadena completa de un documento abierto en el
--     Estudio. "Mis trabajos" muestra UN renglón por sesión (el último job), en
--     vez de un renglón por cada paso intermedio.
--
-- Ambas son NULL para todo lo existente: los jobs de una sola operación (el flujo
-- clásico de /tools/:tool) siguen comportándose exactamente igual.
-- Es aditiva: no altera ni una fila existente.

ALTER TABLE compression_jobs
  ADD COLUMN session_id    VARCHAR(36) NULL AFTER user_id,
  ADD COLUMN parent_job_id VARCHAR(36) NULL AFTER session_id;

-- Índice de sesión: lo usa el plegado de "Mis trabajos" (último job por sesión)
-- y la purga de intermedios.
ALTER TABLE compression_jobs
  ADD INDEX idx_session (session_id, created_at);

-- Índice de padre: lo usa la detección de jobs superados (¿tengo un sucesor?).
ALTER TABLE compression_jobs
  ADD INDEX idx_parent_job (parent_job_id);

-- Si el job padre se borra (purga de intermedios o borrado manual), el hijo
-- sobrevive con parent_job_id NULL: el resultado final NO depende de que su
-- cadena siga existiendo.
ALTER TABLE compression_jobs
  ADD CONSTRAINT fk_jobs_parent
  FOREIGN KEY (parent_job_id) REFERENCES compression_jobs(id) ON DELETE SET NULL;
