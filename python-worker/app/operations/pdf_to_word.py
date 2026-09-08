"""Operación pdf_to_word: PDF → documento Word (.docx) editable."""
from pathlib import Path
from typing import Any, Dict

from app.converters.pdf_word import convert_pdf_to_word
from app.operations.common import (
    custom_basename,
    get_single_original,
    output_path,
    parse_params,
    register_output,
    stem,
)

DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def handle_pdf_to_word(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])

    # custom_basename solo recorta .pdf/.zip; si el usuario escribió "informe.docx"
    # se recorta aquí para no terminar en "informe.docx.docx".
    base = custom_basename(params) or stem(original['original_filename'])
    if base.lower().endswith('.docx'):
        base = base[:-5]
    out_name = f'{base}.docx'
    out_path = output_path(job_id, out_name)

    convert_pdf_to_word(input_path, out_path)

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type=DOCX_MIME)
    return {'files_output': 1}
