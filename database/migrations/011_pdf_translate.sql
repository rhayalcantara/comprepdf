-- 011_pdf_translate.sql — Traducir PDF con LLM local (Ollama)
--
-- Añade la operación de worker `translate`: traduce el texto del PDF a otro
-- idioma manteniendo el diseño (PyMuPDF reemplaza cada bloque de texto in situ;
-- la traducción la hace un LLM vía Ollama en el host del worker).
-- Es aditiva: solo amplía el ENUM de operation_type. Sin cambios de datos.

ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
  ENUM('compress','split','merge','sign','extract','rotate','protect','unlock','certificate','form_generate','pdf_edit','organize','convert','pdf_to_word','pdf_to_excel','translate')
  NOT NULL DEFAULT 'compress';
