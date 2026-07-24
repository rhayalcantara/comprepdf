"""Edición de PDF: estampa una lista de ediciones sobre un PDF existente.

A diferencia de las operaciones de una sola acción (sign, rotate...), aquí
`operation_params.edits` es una LISTA de ediciones de varios tipos, colocadas por
coordenadas normalizadas (0-1, origen abajo-izquierda, convención de la firma).

Fase A: `text`, `image`, `whiteout`. Fase 1 de marcado (tipo Acrobat):
`highlight`, `underline`, `strikeout`, `line`, `arrow`, `rect`, `ellipse` y
`mark` (cross/check/dot). El borrado real del texto existente (`redact`, con
PyMuPDF) sigue pendiente para la Fase B.

Cada página con ediciones se pinta una sola vez: se dibuja un overlay de reportlab
del tamaño exacto de esa página y se fusiona con `pikepdf.Page.add_overlay`. Se usa
reportlab (no operadores de contenido a mano) porque ya maneja bien los acentos y
el dibujo de texto/imágenes/rectángulos.
"""
import io
import json
import math
from datetime import datetime
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

# --- Marcado y formas (Fases 1 y 2 de las herramientas tipo Acrobat) ---
# Tipos que se dibujan como trazos/rellenos vectoriales sobre la caja x,y,w,h.
SHAPE_TYPES = ('highlight', 'underline', 'strikeout', 'line', 'arrow', 'rect', 'ellipse', 'mark',
               'freehand', 'polygon', 'cloud', 'callout', 'stamp')
HIGHLIGHT_COLOR = '#FFDE21'
HIGHLIGHT_ALPHA = 0.35
DEFAULT_STROKE_COLOR = '#B42318'
DEFAULT_STROKE_WIDTH = 2.0
MIN_STROKE_WIDTH, MAX_STROKE_WIDTH = 0.5, 12.0
# Fase 2
MAX_FREEHAND_POINTS = 1500
MAX_POLYGON_POINTS = 200
MAX_STAMP_TEXT = 60
STAMP_FONT = 'Helvetica-Bold'


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

    if etype in SHAPE_TYPES:
        _draw_shape(pdf_canvas, etype, edit, x, y, w, h, pw, ph)
        return True

    return False


def _stroke_width(edit: Dict[str, Any]) -> float:
    try:
        width = float(edit.get('stroke_width', DEFAULT_STROKE_WIDTH))
    except (TypeError, ValueError):
        return DEFAULT_STROKE_WIDTH
    return max(MIN_STROKE_WIDTH, min(width, MAX_STROKE_WIDTH))


def _draw_shape(pdf_canvas: canvas.Canvas, etype: str, edit: Dict[str, Any],
                x: float, y: float, w: float, h: float,
                pw: float, ph: float) -> None:
    """Dibuja un tipo de marcado/forma dentro de la caja (x,y,w,h).

    saveState/restoreState por edición: el alpha del resaltado y el grosor de
    trazo no deben contaminar las ediciones siguientes del mismo overlay.
    """
    color = _hex_color(edit.get('color'),
                       HIGHLIGHT_COLOR if etype == 'highlight' else DEFAULT_STROKE_COLOR)
    width = _stroke_width(edit)
    pdf_canvas.saveState()
    try:
        if etype == 'highlight':
            pdf_canvas.setFillColor(color)
            pdf_canvas.setFillAlpha(HIGHLIGHT_ALPHA)
            pdf_canvas.rect(x, y, w, h, fill=1, stroke=0)
            return
        pdf_canvas.setStrokeColor(color)
        pdf_canvas.setLineWidth(width)
        pdf_canvas.setLineCap(1)  # extremos redondeados
        if etype == 'underline':
            pdf_canvas.line(x, y, x + w, y)
        elif etype == 'strikeout':
            pdf_canvas.line(x, y + h / 2, x + w, y + h / 2)
        elif etype in ('line', 'arrow'):
            _draw_segment(pdf_canvas, etype, edit, x, y, w, h, width)
        elif etype == 'rect':
            pdf_canvas.rect(x, y, w, h, fill=0, stroke=1)
        elif etype == 'ellipse':
            pdf_canvas.ellipse(x, y, x + w, y + h, fill=0, stroke=1)
        elif etype == 'mark':
            _draw_mark(pdf_canvas, edit, x, y, w, h, color)
        elif etype in ('freehand', 'polygon'):
            _draw_path(pdf_canvas, etype, edit, x, y, w, h)
        elif etype == 'cloud':
            _draw_cloud(pdf_canvas, x, y, w, h)
        elif etype == 'callout':
            _draw_callout(pdf_canvas, edit, x, y, w, h, color, pw, ph)
        elif etype == 'stamp':
            _draw_stamp_edit(pdf_canvas, edit, x, y, w, h, color, width)
    finally:
        pdf_canvas.restoreState()


def _draw_segment(pdf_canvas: canvas.Canvas, etype: str, edit: Dict[str, Any],
                  x: float, y: float, w: float, h: float, width: float) -> None:
    """Línea/flecha como diagonal de la caja; `dir` elige cuál ('up' por defecto:
    de abajo-izquierda a arriba-derecha). La flecha lleva la punta en el destino."""
    if str(edit.get('dir', 'up')) == 'down':
        x1, y1, x2, y2 = x, y + h, x + w, y
    else:
        x1, y1, x2, y2 = x, y, x + w, y + h
    pdf_canvas.line(x1, y1, x2, y2)
    if etype == 'arrow':
        _draw_arrowhead(pdf_canvas, x1, y1, x2, y2, width)


def _draw_arrowhead(pdf_canvas: canvas.Canvas, x1: float, y1: float,
                    x2: float, y2: float, width: float) -> None:
    """Punta de flecha en (x2, y2), orientada según el segmento (x1,y1)->(x2,y2)."""
    angle = math.atan2(y2 - y1, x2 - x1)
    head = max(8.0, width * 4.0)
    for delta in (math.radians(150), math.radians(-150)):
        pdf_canvas.line(x2, y2,
                        x2 + head * math.cos(angle + delta),
                        y2 + head * math.sin(angle + delta))


def _parse_points(edit: Dict[str, Any], max_points: int) -> List[Tuple[float, float]]:
    """Puntos del trazo normalizados A LA CAJA (0-1, y hacia arriba), saneados."""
    raw = edit.get('points')
    if not isinstance(raw, list):
        return []
    points: List[Tuple[float, float]] = []
    for item in raw[:max_points]:
        try:
            px, py = float(item[0]), float(item[1])
        except (TypeError, ValueError, IndexError, KeyError):
            continue
        if math.isfinite(px) and math.isfinite(py):
            points.append((min(max(px, 0.0), 1.0), min(max(py, 0.0), 1.0)))
    return points


def _draw_path(pdf_canvas: canvas.Canvas, etype: str, edit: Dict[str, Any],
               x: float, y: float, w: float, h: float) -> None:
    """Dibujo libre (trazo abierto) o polígono (cerrado): puntos escalados a la caja."""
    limit = MAX_POLYGON_POINTS if etype == 'polygon' else MAX_FREEHAND_POINTS
    points = _parse_points(edit, limit)
    if len(points) < 2:
        return
    pdf_canvas.setLineJoin(1)  # esquinas redondeadas
    path = pdf_canvas.beginPath()
    path.moveTo(x + points[0][0] * w, y + points[0][1] * h)
    for px, py in points[1:]:
        path.lineTo(x + px * w, y + py * h)
    if etype == 'polygon':
        path.close()
    pdf_canvas.drawPath(path, stroke=1, fill=0)


def _draw_cloud(pdf_canvas: canvas.Canvas, x: float, y: float, w: float, h: float) -> None:
    """Nube de revisión: semicírculos hacia afuera a lo largo del perímetro."""
    radius = max(5.0, min(min(w, h) / 6.0, 14.0))
    nx = max(2, int(round(w / (2 * radius))))
    ny = max(2, int(round(h / (2 * radius))))
    sx, sy = w / nx, h / ny
    for i in range(nx):
        x0, x1 = x + i * sx, x + (i + 1) * sx
        pdf_canvas.arc(x0, y - radius, x1, y + radius, 180, 180)          # borde inferior
        pdf_canvas.arc(x0, y + h - radius, x1, y + h + radius, 0, 180)    # borde superior
    for j in range(ny):
        y0, y1 = y + j * sy, y + (j + 1) * sy
        pdf_canvas.arc(x - radius, y0, x + radius, y1, 90, 180)           # borde izquierdo
        pdf_canvas.arc(x + w - radius, y0, x + w + radius, y1, 270, 180)  # borde derecho


def _draw_callout(pdf_canvas: canvas.Canvas, edit: Dict[str, Any],
                  x: float, y: float, w: float, h: float, color: colors.Color,
                  pw: float, ph: float) -> None:
    """Llamada de texto: burbuja blanca con borde + flecha hacia el tip (coords de página)."""
    tip = edit.get('tip')
    try:
        tx = min(max(float(tip[0]), 0.0), 1.0) * pw
        ty = min(max(float(tip[1]), 0.0), 1.0) * ph
    except (TypeError, ValueError, IndexError):
        tx = ty = None

    # La línea primero: la burbuja tapa su arranque y queda limpio.
    if tx is not None and not (x <= tx <= x + w and y <= ty <= y + h):
        ax = min(max(tx, x), x + w)  # punto del borde de la caja más cercano al tip
        ay = min(max(ty, y), y + h)
        pdf_canvas.line(ax, ay, tx, ty)
        _draw_arrowhead(pdf_canvas, ax, ay, tx, ty, _stroke_width(edit))

    pdf_canvas.setFillColor(colors.white)
    pdf_canvas.roundRect(x, y, w, h, min(6.0, h / 4), fill=1, stroke=1)
    text = str(edit.get('text', '')).strip()
    if text:
        pad = 4.0
        _draw_text(pdf_canvas, text, x + pad, y + pad, w - 2 * pad, h - 2 * pad,
                   _font_size(edit), color)


def _draw_stamp_edit(pdf_canvas: canvas.Canvas, edit: Dict[str, Any],
                     x: float, y: float, w: float, h: float,
                     color: colors.Color, stroke_width: float) -> None:
    """Sello: borde redondeado + texto en mayúsculas ajustado + fecha opcional.

    La fecha la pone el WORKER al procesar (como el sello de la firma): marca
    cuándo se selló de verdad y no es falseable desde el navegador.
    """
    lines = [(str(edit.get('text', '')).strip() or 'SELLO')[:MAX_STAMP_TEXT].upper()]
    if edit.get('show_datetime'):
        lines.append(datetime.now().strftime('%d/%m/%Y %H:%M'))

    pad = max(3.0, h * 0.12)
    size = (h - 2 * pad) / (len(lines) * 1.25)
    usable = w - 2 * pad
    while size > 4.0 and any(
            pdfmetrics.stringWidth(line, STAMP_FONT, size) > usable for line in lines):
        size *= 0.92

    pdf_canvas.roundRect(x, y, w, h, min(6.0, h / 4), fill=0, stroke=1)
    pdf_canvas.setFillColor(color)
    pdf_canvas.setFont(STAMP_FONT, size)
    leading = size * 1.25
    baseline = y + h - pad - size
    for line in lines:
        pdf_canvas.drawCentredString(x + w / 2, baseline, line)
        baseline -= leading


def _draw_mark(pdf_canvas: canvas.Canvas, edit: Dict[str, Any],
               x: float, y: float, w: float, h: float, color: colors.Color) -> None:
    """Marca rápida (cross/check/dot) como glifo cuadrado centrado en la caja."""
    kind = str(edit.get('mark', 'check'))
    s = min(w, h)
    x0 = x + (w - s) / 2
    y0 = y + (h - s) / 2
    if kind == 'dot':
        pdf_canvas.setFillColor(color)
        pdf_canvas.ellipse(x0, y0, x0 + s, y0 + s, fill=1, stroke=0)
    elif kind == 'cross':
        pdf_canvas.line(x0, y0, x0 + s, y0 + s)
        pdf_canvas.line(x0, y0 + s, x0 + s, y0)
    else:  # check
        pdf_canvas.line(x0 + s * 0.10, y0 + s * 0.50, x0 + s * 0.38, y0 + s * 0.15)
        pdf_canvas.line(x0 + s * 0.38, y0 + s * 0.15, x0 + s * 0.90, y0 + s * 0.85)


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
