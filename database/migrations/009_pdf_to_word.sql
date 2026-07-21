-- 009_pdf_to_word.sql — PDF a Word (.docx) con pdf2docx
--
-- Añade la operación de worker `pdf_to_word`: recibe un PDF con texto
-- extraíble y reconstruye un .docx editable (aproximado: un PDF no guarda
-- estructura). Los PDFs cifrados o escaneados se rechazan con mensaje claro.
-- Es aditiva: solo amplía el ENUM de operation_type. Sin cambios de datos.

ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
  ENUM('compress','split','merge','sign','extract','rotate','protect','unlock','certificate','form_generate','pdf_edit','organize','convert','pdf_to_word')
  NOT NULL DEFAULT 'compress';
