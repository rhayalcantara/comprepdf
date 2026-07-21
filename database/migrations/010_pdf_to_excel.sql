-- 010_pdf_to_excel.sql — PDF a Excel (.xlsx): extracción de tablas
--
-- Añade la operación de worker `pdf_to_excel`: detecta las TABLAS del PDF
-- (PyMuPDF find_tables) y las vuelca a un libro Excel, una hoja por tabla.
-- El texto suelto no se exporta; sin tablas detectables → error claro.
-- Es aditiva: solo amplía el ENUM de operation_type. Sin cambios de datos.

ALTER TABLE compression_jobs
  MODIFY COLUMN operation_type
  ENUM('compress','split','merge','sign','extract','rotate','protect','unlock','certificate','form_generate','pdf_edit','organize','convert','pdf_to_word','pdf_to_excel')
  NOT NULL DEFAULT 'compress';
