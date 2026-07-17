-- 006_pdf_edit.sql — Edición de PDF (estampar texto/imágenes y tapar)
--
-- Añade la operación de worker `pdf_edit`: recibe un PDF y una lista de ediciones
-- (texto, imagen, tapado) en operation_params.edits, y las estampa sobre el PDF.
-- Es aditiva: solo amplía el ENUM de operation_type. Sin cambios de datos.

ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
  ENUM('compress','split','merge','sign','extract','rotate','protect','unlock','certificate','form_generate','pdf_edit')
  NOT NULL DEFAULT 'compress';
