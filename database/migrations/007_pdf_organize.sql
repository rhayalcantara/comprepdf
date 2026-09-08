-- 007_pdf_organize.sql — Organizar páginas (reordenar, eliminar y rotar)
--
-- Añade la operación de worker `organize`: recibe un PDF y la lista final de
-- páginas en operation_params.pages (cada una con su página de origen y su
-- rotación), y reconstruye el documento con ese orden. Las páginas que el
-- usuario elimina simplemente no aparecen en la lista.
-- Es aditiva: solo amplía el ENUM de operation_type. Sin cambios de datos.

ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
  ENUM('compress','split','merge','sign','extract','rotate','protect','unlock','certificate','form_generate','pdf_edit','organize')
  NOT NULL DEFAULT 'compress';
