"""Conversión PDF → Word (.docx) con pdf2docx — sin Office.

Un PDF es un formato de impresión sin estructura de párrafos/tablas, así que
esto es una RECONSTRUCCIÓN aproximada, no una conversión fiel; la UI ya avisa.
pdf2docx (PyMuPDF + python-docx) reconstruye texto, tablas e imágenes de PDFs
"normales". Antes de convertir se valida lo que produciría un docx vacío o un
cuelgue: PDFs cifrados y PDFs escaneados (sin texto extraíble).
"""
import logging
from pathlib import Path

import fitz  # PyMuPDF (dependencia de pdf2docx)
from pdf2docx import Converter

# pdf2docx es muy verboso por logging (una línea por página); en el worker solo
# interesan sus errores.
logging.getLogger('pdf2docx').setLevel(logging.ERROR)


def convert_pdf_to_word(input_path: Path, output_path: Path) -> None:
    """Convierte un PDF a .docx. Lanza ValueError con mensaje claro si no se puede."""
    assert_pdf_extractable(input_path)

    converter = Converter(str(input_path))
    try:
        converter.convert(str(output_path))
    except Exception:
        raise ValueError('The PDF could not be converted to Word')
    finally:
        converter.close()

    # Un docx es un contenedor ZIP: si no empieza por PK, algo salió mal.
    if not output_path.exists() or output_path.stat().st_size == 0:
        raise ValueError('Conversion produced no output')
    with open(output_path, 'rb') as fh:
        if fh.read(2) != b'PK':
            raise ValueError('Conversion did not produce a valid Word document')


def assert_pdf_extractable(input_path: Path) -> None:
    """Rechaza con mensaje claro los PDFs sin texto extraíble (cifrados o
    escaneados). Compartida por pdf_to_word y pdf_to_excel."""
    try:
        doc = fitz.open(str(input_path))
    except Exception:
        raise ValueError('File is not a valid PDF')
    try:
        if doc.needs_pass:
            raise ValueError('The PDF is password-protected; unlock it first')
        # Sin texto extraíble = PDF escaneado (solo imágenes): el resultado
        # sería un docx vacío. Mejor un error claro que un archivo inservible.
        if not any(page.get_text().strip() for page in doc):
            raise ValueError(
                'The PDF has no extractable text (it looks scanned); '
                'OCR is required and not supported yet')
    finally:
        doc.close()
