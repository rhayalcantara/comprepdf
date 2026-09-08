"""Operación pdf_to_excel: tablas de un PDF → libro Excel (.xlsx)."""
from pathlib import Path
from typing import Any, Dict

from app.converters.pdf_excel import convert_pdf_to_excel
from app.operations.common import (
    custom_basename,
    get_single_original,
    output_path,
    parse_params,
    register_output,
    stem,
)

XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'


def handle_pdf_to_excel(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])

    # custom_basename solo recorta .pdf/.zip; un ".xlsx" escrito por el usuario
    # se recorta aquí (mismo criterio que pdf_to_word con .docx).
    base = custom_basename(params) or stem(original['original_filename'])
    if base.lower().endswith('.xlsx'):
        base = base[:-5]
    out_name = f'{base}.xlsx'
    out_path = output_path(job_id, out_name)

    tables = convert_pdf_to_excel(input_path, out_path)

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type=XLSX_MIME)
    return {'files_output': 1, 'tables_extracted': tables}
