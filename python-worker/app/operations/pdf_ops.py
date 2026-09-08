"""Operaciones PDF basadas en pikepdf: split, merge, extract, rotate, organize,
protect, unlock."""
import io
import zipfile
from pathlib import Path
from typing import Any, Dict, List

import pikepdf

from app.operations.common import (
    custom_basename,
    get_original_files,
    get_single_original,
    output_path,
    parse_page_list,
    parse_params,
    register_output,
    stem,
)


def _pdf_bytes(pdf: pikepdf.Pdf) -> bytes:
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def handle_split(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Divide un PDF en páginas individuales o por rangos y empaqueta en un ZIP."""
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = stem(original['original_filename'])

    mode = params.get('mode', 'individual')  # 'individual' | 'ranges'
    custom = custom_basename(params)
    zip_base = custom or f"{base}_split"
    part_prefix = custom or base
    zip_path = output_path(job_id, f"{zip_base}.zip")
    parts = 0

    with pikepdf.open(input_path) as src:
        page_count = len(src.pages)
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            if mode == 'ranges':
                ranges: List[str] = params.get('ranges') or []
                if not ranges:
                    raise ValueError("No ranges provided for split")
                for r in ranges:
                    indices = parse_page_list(r, page_count)
                    out = pikepdf.Pdf.new()
                    for idx in indices:
                        out.pages.append(src.pages[idx])
                    label = str(r).replace(' ', '').replace(',', '_')
                    zf.writestr(f"{part_prefix}_{label}.pdf", _pdf_bytes(out))
                    parts += 1
            else:  # individual
                for i in range(page_count):
                    out = pikepdf.Pdf.new()
                    out.pages.append(src.pages[i])
                    zf.writestr(f"{part_prefix}_page_{i + 1}.pdf", _pdf_bytes(out))
                    parts += 1

    register_output(cursor, job_id, zip_path,
                    download_name=f"{zip_base}.zip",
                    mime_type='application/zip')
    return {'files_output': parts}


def handle_merge(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Une varios PDFs en uno solo respetando file_order si se provee.

    Si `page_ranges` está presente (lista paralela a file_order), de cada PDF se
    toman solo las páginas indicadas ("all" o una lista tipo "1-3,5"); si falta o
    es "all" se incluye el documento completo.
    """
    job_id = job['id']
    params = parse_params(job)
    file_order = params.get('file_order')
    originals = get_original_files(cursor, job_id, file_order=file_order)
    if len(originals) < 2:
        raise ValueError("Merge requires at least 2 files")

    page_ranges = params.get('page_ranges')
    if not isinstance(page_ranges, list):
        page_ranges = []

    out_name = f"{custom_basename(params) or 'merged'}.pdf"
    out_path = output_path(job_id, out_name)
    merged = pikepdf.Pdf.new()
    sources = []
    try:
        for i, original in enumerate(originals):
            src = pikepdf.open(Path(original['file_path']))
            sources.append(src)
            spec = page_ranges[i] if i < len(page_ranges) else None
            if spec in (None, '', 'all'):
                merged.pages.extend(src.pages)
            else:
                for idx in parse_page_list(spec, len(src.pages)):
                    merged.pages.append(src.pages[idx])
        merged.save(out_path)
    finally:
        for src in sources:
            src.close()
        merged.close()

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1, 'merged_count': len(originals)}


def handle_extract(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Extrae páginas seleccionadas a un nuevo PDF."""
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = stem(original['original_filename'])

    selection = params.get('pages')
    if selection is None:
        raise ValueError("No pages specified for extract")

    out_name = f"{custom_basename(params) or base + '_extracted'}.pdf"
    out_path = output_path(job_id, out_name)
    with pikepdf.open(input_path) as src:
        indices = parse_page_list(selection, len(src.pages))
        out = pikepdf.Pdf.new()
        for idx in indices:
            out.pages.append(src.pages[idx])
        out.save(out_path)

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1, 'pages_extracted': len(indices)}


def handle_rotate(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Rota páginas (todas o seleccionadas) un múltiplo de 90 grados."""
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = stem(original['original_filename'])

    degrees = int(params.get('degrees', 90)) % 360
    if degrees % 90 != 0:
        raise ValueError("Rotation must be a multiple of 90 degrees")

    out_name = f"{custom_basename(params) or base + '_rotated'}.pdf"
    out_path = output_path(job_id, out_name)
    with pikepdf.open(input_path) as pdf:
        page_count = len(pdf.pages)
        selection = params.get('pages')
        if selection in (None, 'all', ''):
            indices = list(range(page_count))
        else:
            indices = parse_page_list(selection, page_count)

        for idx in indices:
            page = pdf.pages[idx]
            current = int(page.get('/Rotate', 0))
            page.Rotate = (current + degrees) % 360
        pdf.save(out_path)

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1, 'pages_rotated': len(indices), 'degrees': degrees}


def handle_organize(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Reconstruye el PDF con la lista final de páginas (reordenar/eliminar/rotar).

    `params['pages']` es esa lista en el orden de salida; cada entrada tiene
    `source` (página del original, 1-based) y `rotate` (giro RELATIVO al que ya
    tuviera la página, como en handle_rotate). Lo que el usuario elimina no
    aparece en la lista, así que aquí no hay un "borrar": se copia lo que hay.
    Una página repetida se duplica de verdad (pikepdf crea un objeto por copia),
    por lo que cada copia puede llevar su propia rotación.
    """
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = stem(original['original_filename'])

    pages = params.get('pages')
    if not isinstance(pages, list) or not pages:
        raise ValueError("No pages specified for organize")

    out_name = f"{custom_basename(params) or base + '_organizado'}.pdf"
    out_path = output_path(job_id, out_name)
    rotated = 0
    kept_sources = set()

    with pikepdf.open(input_path) as src:
        page_count = len(src.pages)
        out = pikepdf.Pdf.new()
        try:
            for entry in pages:
                if not isinstance(entry, dict):
                    raise ValueError("Each organize page must be an object")
                try:
                    source = int(entry.get('source'))
                except (TypeError, ValueError):
                    raise ValueError("Organize page source must be an integer")
                if not 1 <= source <= page_count:
                    raise ValueError(
                        f"Page {source} is out of range (the PDF has {page_count})")

                out.pages.append(src.pages[source - 1])
                kept_sources.add(source)
                degrees = int(entry.get('rotate', 0) or 0) % 360
                if degrees:
                    if degrees % 90 != 0:
                        raise ValueError("Rotation must be a multiple of 90 degrees")
                    page = out.pages[-1]
                    page.Rotate = (int(page.get('/Rotate', 0)) + degrees) % 360
                    rotated += 1
            out.save(out_path)
        finally:
            out.close()

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    # `pages_kept` cuenta la salida (una página duplicada suma dos) y
    # `pages_removed` las del original que no sobrevivieron.
    return {'files_output': 1, 'pages_kept': len(pages),
            'pages_removed': page_count - len(kept_sources), 'pages_rotated': rotated}


def handle_protect(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Cifra el PDF con contraseña de usuario (y de propietario opcional)."""
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = stem(original['original_filename'])

    password = params.get('password')
    if not password:
        raise ValueError("Password is required to protect the PDF")
    owner = params.get('owner_password') or password

    out_name = f"{custom_basename(params) or base + '_protected'}.pdf"
    out_path = output_path(job_id, out_name)
    with pikepdf.open(input_path) as pdf:
        pdf.save(
            out_path,
            encryption=pikepdf.Encryption(user=password, owner=owner, R=6),
        )

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1}


def handle_unlock(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Quita la protección por contraseña de un PDF (requiere la contraseña actual)."""
    job_id = job['id']
    params = parse_params(job)
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = stem(original['original_filename'])

    password = params.get('password', '')
    out_name = f"{custom_basename(params) or base + '_unlocked'}.pdf"
    out_path = output_path(job_id, out_name)
    try:
        with pikepdf.open(input_path, password=password) as pdf:
            pdf.save(out_path)  # sin encryption -> se remueve el cifrado
    except pikepdf.PasswordError:
        raise ValueError("Incorrect password for the PDF")

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1}
