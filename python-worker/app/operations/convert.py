"""Operación convert: documento Office/imagen → PDF.

El despacho es por la EXTENSIÓN del nombre original (el backend ya validó
extensión + magic bytes por familia); cada familia va a su conversor en
app/converters/. La salida se valida como PDF real antes de registrarla:
Office puede "terminar" dejando un archivo vacío o a medias.
"""
from pathlib import Path
from typing import Any, Dict

from app.converters.image_pdf import convert_image
from app.converters.office_com import convert_excel, convert_powerpoint, convert_word
from app.operations.common import (
    custom_basename,
    get_single_original,
    output_path,
    parse_params,
    register_output,
    stem,
)

WORD_EXTS = {'.doc', '.docx', '.rtf', '.odt', '.txt'}
EXCEL_EXTS = {'.xls', '.xlsx', '.ods'}
PPT_EXTS = {'.ppt', '.pptx', '.odp'}
IMAGE_EXTS = {'.jpg', '.jpeg', '.png'}

SUPPORTED_EXTS = WORD_EXTS | EXCEL_EXTS | PPT_EXTS | IMAGE_EXTS


def handle_convert(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    ext = Path(original['original_filename']).suffix.lower()

    out_name = f"{custom_basename(params) or stem(original['original_filename'])}.pdf"
    out_path = output_path(job_id, out_name)

    if ext in IMAGE_EXTS:
        convert_image(input_path, out_path)
    elif ext in WORD_EXTS:
        convert_word(input_path, out_path)
    elif ext in EXCEL_EXTS:
        convert_excel(input_path, out_path)
    elif ext in PPT_EXTS:
        convert_powerpoint(input_path, out_path)
    else:
        raise ValueError(f"Unsupported file type for conversion: {ext or '(none)'}")

    _assert_pdf_output(out_path)

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1, 'source_format': ext.lstrip('.')}


def _assert_pdf_output(out_path: Path) -> None:
    """La conversión "exitosa" debe haber dejado un PDF de verdad en disco."""
    if not out_path.exists() or out_path.stat().st_size == 0:
        raise ValueError('Conversion produced no output')
    with open(out_path, 'rb') as fh:
        if not fh.read(5).startswith(b'%PDF-'):
            raise ValueError('Conversion did not produce a valid PDF')
