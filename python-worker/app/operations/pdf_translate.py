"""Operación translate: traduce el texto del PDF con un LLM local (Ollama)."""
from pathlib import Path
from typing import Any, Dict

from app.converters.pdf_translate import SUPPORTED_LANGS, translate_pdf
from app.operations.common import (
    custom_basename,
    get_single_original,
    output_path,
    parse_params,
    register_output,
    stem,
)


def handle_translate(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    job_id = job['id']
    params = parse_params(job)

    target_lang = str(params.get('target_lang') or '')
    if target_lang not in SUPPORTED_LANGS:
        raise ValueError(f"Unsupported target language: {target_lang or '(none)'}")

    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])

    # Si el usuario eligió nombre se respeta tal cual; si no, el original
    # lleva el idioma como sufijo ("informe" -> "informe_en.pdf").
    base = custom_basename(params)
    out_name = f'{base}.pdf' if base else f"{stem(original['original_filename'])}_{target_lang}.pdf"
    out_path = output_path(job_id, out_name)

    translate_pdf(input_path, out_path, target_lang)

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1}
