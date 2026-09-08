-- 008_convert.sql — Convertir a PDF (Word/Excel/PowerPoint/imágenes)
--
-- Añade la operación de worker `convert`: recibe un documento Office
-- (.doc/.docx/.rtf/.odt/.txt/.xls/.xlsx/.ods/.ppt/.pptx/.odp) o una imagen
-- (.jpg/.png) y produce un PDF. La conversión Office se hace vía COM en la
-- máquina del worker; las imágenes con Pillow.
-- Es aditiva: solo amplía el ENUM de operation_type. Sin cambios de datos.

ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
  ENUM('compress','split','merge','sign','extract','rotate','protect','unlock','certificate','form_generate','pdf_edit','organize','convert')
  NOT NULL DEFAULT 'compress';
