"""Edición de PDF: estampa una lista de ediciones sobre un PDF existente.

A diferencia de las operaciones de una sola acción (sign, rotate...), aquí
`operation_params.edits` es una LISTA de ediciones de varios tipos, colocadas por
coordenadas normalizadas (0-1, origen abajo-izquierda, convención de la firma).

Fase A (este archivo): `text`, `image`, `whiteout`. El borrado real del texto
existente (`redact`, con PyMuPDF) se añade en la Fase B.

Cada página con ediciones se pinta una sola vez: se dibuja un overlay de reportlab
del tamaño exacto de esa página y se fusiona con `pikepdf.Page.add_overlay`. Se usa
reportlab (no operadores de contenido a mano) porque ya maneja bien los acentos y
el dibujo de texto/imágenes/rectángulos.
"""
import io
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pikepdf
from PIL import Image, UnidentifiedImageError
from reportlab.lib import colors
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas

from app.operations.common import (
    custom_basename,
    get_single_original,
    output_path,
    parse_params,
    register_output,
    stem,
)

FONT = 'Helvetica'
DEFAULT_FONT_SIZE = 12
DEFAULT_TEXT_COLOR = '#101828'
DEFAULT_FILL_COLOR = '#FFFFFF'
LINE_LEADING = 1.2
# Tope de píxeles al decodificar (defensa anti-bomba; el backend ya acota bytes).
MAX_IMAGE_PX = 6000


def _hex_color(value: Any, default: str) -> colors.Color:
    try:
        return colors.HexColor(str(value))
    except (ValueError, TypeError):
        return colors.HexColor(default)


def _load_image(path: str) -> Optional[Image.Image]:
    """Decodifica una imagen subida. `None` si falta o no es válida.

    Solo llegan al PDF los píxeles decodificados, nunca los bytes originales
    (mismo criterio que sign.py). Una imagen rota no tumba el job: se omite esa
    edición y el resto del PDF sale igual.
    """
    if not path or not Path(path).exists():
        return None
    try:
        with Image.open(path) as raw:
            raw.load()
            image = raw.convert('RGBA')
    except Image.DecompressionBombError:
        return None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        return None
    if image.width > MAX_IMAGE_PX or image.height > MAX_IMAGE_PX:
        return None
    return image


def _page_box(page: pikepdf.Page) -> Tuple[float, float, float, float]:
    """(llx, lly, ancho, alto) del MediaBox en puntos, normalizando el orden."""
    mb = [float(v) for v in page.mediabox]
    llx, urx = min(mb[0], mb[2]), max(mb[0], mb[2])
    lly, ury = min(mb[1], mb[3]), max(mb[1], mb[3])
    return llx, lly, urx - llx, ury - lly


def _rect_points(edit: Dict[str, Any], pw: float, ph: float) -> Tuple[float, float, float, float]:
    """Normalizado (x,y,w,h) -> (x,y,w,h) en puntos DENTRO del overlay (origen 0,0).

    El offset del MediaBox lo aplica `add_overlay` al mapear el overlay sobre la
    página destino, así que aquí se trabaja siempre desde (0,0). Se hace clamp
    para que la caja no se salga.
    """
    def frac(key: str, default: float) -> float:
        try:
            return float(edit.get(key, default))
        except (TypeError, ValueError):
            return default

    w = max(0.0, min(frac('w', 0.2), 1.0)) * pw
    h = max(0.0, min(frac('h', 0.05), 1.0)) * ph
    x = max(0.0, min(frac('x', 0.0), 1.0)) * pw
    y = max(0.0, min(frac('y', 0.0), 1.0)) * ph
    x = max(0.0, min(x, pw - w))
    y = max(0.0, min(y, ph - h))
    return x, y, w, h


def _wrap_lines(text: str, font_size: float, max_width: float) -> List[str]:
    """Parte el texto en líneas que quepan en `max_width` (respeta los \\n)."""
    lines: List[str] = []
    for paragraph in str(text).split('\n'):
        words = paragraph.split(' ')
        current = ''
        for word in words:
            candidate = f'{current} {word}'.strip()
            if current and pdfmetrics.stringWidth(candidate, FONT, font_size) > max_width:
                lines.append(current)
                current = word
            else:
                current = candidate
        lines.append(current)
    return lines


def _draw_text(pdf_canvas: canvas.Canvas, text: str, x: float, y: float,
               w: float, h: float, font_size: float, color: colors.Color) -> None:
    """Dibuja el texto dentro de la caja (x,y,w,h), de arriba a abajo, con ajuste."""
    pdf_canvas.setFillColor(color)
    pdf_canvas.setFont(FONT, font_size)
    leading = font_size * LINE_LEADING
    # Primera línea base: pegada al borde superior de la caja.
    baseline = y + h - font_size
    bottom = y
    for line in _wrap_lines(text, font_size, w):
        if baseline < bottom - font_size:  # se salió por abajo: corta
            break
        pdf_canvas.drawString(x, baseline, line)
        baseline -= leading


def _draw_edit(pdf_canvas: canvas.Canvas, edit: Dict[str, Any], pw: float, ph: float) -> bool:
    """Dibuja una edición en el overlay. Devuelve True si dibujó algo."""
    etype = str(edit.get('type', ''))
    x, y, w, h = _rect_points(edit, pw, ph)
    if w <= 0 or h <= 0:
        return False

    if etype == 'image':
        image = _load_image(str(edit.get('image_path', '')))
        if image is None:
            return False
        pdf_canvas.drawImage(ImageReader(image), x, y, width=w, height=h,
                             mask='auto', preserveAspectRatio=True, anchor='sw')
        return True

    if etype in ('whiteout', 'redact'):
        # En la Fase A, redact se comporta como whiteout (tapa). En la Fase B se
        # añade delante la pasada de PyMuPDF que borra de verdad lo de debajo.
        if etype == 'whiteout':
            pdf_canvas.setFillColor(_hex_color(edit.get('color'), DEFAULT_FILL_COLOR))
            pdf_canvas.rect(x, y, w, h, fill=1, stroke=0)
        text = str(edit.get('text', '')).strip()
        if text:
            size = _font_size(edit)
            _draw_text(pdf_canvas, text, x, y, w, h, size,
                       _hex_color(edit.get('color_text', DEFAULT_TEXT_COLOR), DEFAULT_TEXT_COLOR))
        return True

    if etype == 'text':
        text = str(edit.get('text', '')).strip()
        if not text:
            return False
        _draw_text(pdf_canvas, text, x, y, w, h, _font_size(edit),
                   _hex_color(edit.get('color'), DEFAULT_TEXT_COLOR))
        return True

    return False


def _font_size(edit: Dict[str, Any]) -> float:
    try:
        size = float(edit.get('font_size', DEFAULT_FONT_SIZE))
    except (TypeError, ValueError):
        return DEFAULT_FONT_SIZE
    return max(4.0, min(size, 96.0))


def _overlay_for_page(edits: List[Dict[str, Any]], pw: float, ph: float) -> Optional[bytes]:
    """Genera el PDF-overlay (una página pw×ph) con todas las ediciones. None si
    ninguna dibujó nada."""
    buf = io.BytesIO()
    pdf_canvas = canvas.Canvas(buf, pagesize=(pw, ph))
    drew = False
    for edit in edits:
        if _draw_edit(pdf_canvas, edit, pw, ph):
            drew = True
    if not drew:
        return None
    pdf_canvas.save()
    return buf.getvalue()


def apply_edits(input_pdf: Path, edits: List[Dict[str, Any]], out_path: Path) -> int:
    """Aplica las ediciones y escribe out_path. Devuelve cuántas se aplicaron."""
    by_page: Dict[int, List[Dict[str, Any]]] = {}
    for edit in edits:
        try:
            page = int(edit.get('page', 0))
        except (TypeError, ValueError):
            continue
        by_page.setdefault(page - 1, []).append(edit)  # page es 1-based

    applied = 0
    with pikepdf.open(input_pdf) as pdf:
        page_count = len(pdf.pages)
        for idx, page_edits in by_page.items():
            if not (0 <= idx < page_count):
                continue
            page = pdf.pages[idx]
            _, _, pw, ph = _page_box(page)
            overlay_bytes = _overlay_for_page(page_edits, pw, ph)
            if overlay_bytes is None:
                continue
            with pikepdf.open(io.BytesIO(overlay_bytes)) as overlay:
                llx, lly, w, h = _page_box(page)
                rect = pikepdf.Rectangle(llx, lly, llx + w, lly + h)
                pikepdf.Page(page).add_overlay(overlay.pages[0], rect)
            applied += len(page_edits)
        pdf.save(out_path)
    return applied


def _cleanup_images(cursor, job_id: str, edits: List[Dict[str, Any]]) -> None:
    """Borra del disco las imágenes subidas y quita sus rutas de operation_params.

    Las imágenes van a UPLOAD_DIR sin fila en `files` (como la firma), así que se
    limpian aquí para no dejar archivos ni rutas en la BD. Best-effort."""
    touched = False
    for edit in edits:
        path = edit.get('image_path')
        if path:
            try:
                Path(path).unlink(missing_ok=True)
            except OSError:
                pass
            edit['image_path'] = ''
            touched = True
    if touched:
        try:
            cursor.execute(
                "UPDATE compression_jobs SET operation_params = %s WHERE id = %s",
                (json.dumps({'edits': edits}), job_id),
            )
        except Exception:
            pass


def handle_pdf_edit(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    """Estampa las ediciones de operation_params.edits sobre el PDF original."""
    job_id = job['id']
    params = parse_params(job)
    edits = params.get('edits')
    if not isinstance(edits, list) or not edits:
        raise ValueError('pdf_edit job has no edits')

    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = custom_basename(params) or f"{stem(original['original_filename'])}_editado"
    out = output_path(job_id, f'{base}.pdf')

    applied = apply_edits(input_path, edits, out)
    _cleanup_images(cursor, job_id, edits)

    register_output(cursor, job_id, out,
                    download_name=f'{base}.pdf',
                    mime_type='application/pdf')
    return {'edits': applied}
