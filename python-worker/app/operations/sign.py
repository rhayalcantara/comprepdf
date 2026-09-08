"""Firma de PDFs en tres modos (operation_params.mode):

  - 'certificate' (default; jobs sin `mode` caen aquí — retrocompatible):
    firma criptográfica con certificado PKCS#12 (.pfx/.p12) usando pyHanko.
  - 'drawn': estampa la imagen de la firma dibujada (PNG/JPG) como XObject en
    las páginas elegidas usando pikepdf + Pillow. NO es criptográfica.
  - 'combined': estampa primero y después firma criptográficamente el
    documento ya estampado (la imagen queda protegida por la firma).

Seguridad: el certificado, su contraseña y la imagen de la firma (dato
biométrico conductual) se usan una sola vez y se destruyen inmediatamente
después: los archivos se borran del disco y las rutas/contraseña se eliminan
de operation_params. Nunca se registran en logs. La imagen del usuario nunca
se incrusta tal cual: se decodifica con Pillow y solo los píxeles crudos
(RGB + canal alfa como SMask) entran al PDF, lo que neutraliza cualquier
payload embebido en el archivo original.
"""
import io
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pikepdf
from PIL import Image, UnidentifiedImageError
from pyhanko.sign import signers
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfgen import canvas as rl_canvas

from app.operations.common import (
    custom_basename,
    get_single_original,
    output_path,
    parse_page_list,
    parse_params,
    register_output,
    stem,
)

# Límite defensivo contra imágenes desproporcionadas (el backend limita a 2MB;
# esto cubre PNG muy comprimidos). Image.MAX_IMAGE_PIXELS de Pillow queda
# activo (default) contra decompression bombs.
MAX_SIGNATURE_WIDTH_PX = 2000

# --- Sello de texto bajo la firma dibujada ---
# Proporciones del sello RESPECTO AL ANCHO del recuadro de la firma, para que al
# redimensionarla el sello escale con ella. El frontend (sign-placement) repite
# estas mismas constantes para que la vista previa coincida con el PDF: si
# cambias una, cambia la otra.
STAMP_FONT = 'Helvetica-Bold'
STAMP_FONT_RATIO = 0.11      # tamaño de letra = 11% del ancho del recuadro
STAMP_FONT_MIN = 5.0
STAMP_FONT_MAX = 30.0
STAMP_LEADING = 1.3          # alto de línea en múltiplos del tamaño de letra
STAMP_PADDING_RATIO = 0.4    # margen interno en múltiplos del tamaño de letra
STAMP_BORDER_RATIO = 0.09    # grosor del borde en múltiplos del tamaño de letra
STAMP_DEFAULT_COLOR = '#B42318'
MAX_STAMP_TEXT = 60


def handle_sign(job: Dict[str, Any], cursor) -> Dict[str, Any]:
    job_id = job['id']
    params = parse_params(job)
    mode = params.get('mode') or 'certificate'
    original = get_single_original(cursor, job_id)
    input_path = Path(original['file_path'])
    base = stem(original['original_filename'])

    cert_path = params.get('cert_path')
    signature_path = params.get('signature_path')

    out_name = f"{custom_basename(params) or base + '_signed'}.pdf"
    out_path = output_path(job_id, out_name)

    tmp_stamped: Optional[Path] = None
    try:
        if mode == 'certificate':
            _sign_with_certificate(input_path, out_path, params)
        elif mode == 'drawn':
            x, y, w = _placement(params)
            _stamp_drawn_signature(
                input_path, signature_path, params.get('pages', 'all'),
                x, y, w, out_path, params.get('stamp'),
            )
        elif mode == 'combined':
            x, y, w = _placement(params)
            tmp_stamped = out_path.with_name(f"stamped_{out_path.name}")
            _stamp_drawn_signature(
                input_path, signature_path, params.get('pages', 'all'),
                x, y, w, tmp_stamped, params.get('stamp'),
            )
            _sign_with_certificate(tmp_stamped, out_path, params)
        else:
            raise ValueError(f"Unknown sign mode: {mode}")
    finally:
        if tmp_stamped is not None:
            try:
                tmp_stamped.unlink(missing_ok=True)
            except OSError:
                pass
        _destroy_sign_artifacts(cursor, job_id, cert_path, signature_path)

    register_output(cursor, job_id, out_path,
                    download_name=out_name, mime_type='application/pdf')
    return {'files_output': 1}


# --- Firma criptográfica (pyHanko) ---

def _sign_with_certificate(input_path: Path, out_path: Path, params: Dict[str, Any]) -> None:
    """Firma `input_path` con el certificado de params y escribe `out_path`."""
    cert_path = params.get('cert_path')
    cert_password = params.get('cert_password', '')
    if not cert_path or not Path(cert_path).exists():
        raise ValueError("Signing certificate (.pfx) not found")

    field_name = params.get('field_name') or 'Signature1'
    reason = params.get('reason')
    location = params.get('location')

    try:
        signer = signers.SimpleSigner.load_pkcs12(
            pfx_file=cert_path,
            passphrase=cert_password.encode('utf-8') if cert_password else None,
        )
    except Exception:
        # No filtrar detalles del certificado ni la contraseña en el mensaje
        raise ValueError("Invalid certificate or certificate password")

    if signer is None:
        raise ValueError("Invalid certificate or certificate password")

    meta = signers.PdfSignatureMetadata(
        field_name=field_name,
        reason=reason,
        location=location,
    )

    with open(input_path, 'rb') as inf:
        writer = IncrementalPdfFileWriter(inf)
        with open(out_path, 'wb') as outf:
            signers.sign_pdf(writer, meta, signer=signer, output=outf)


# --- Estampado de la firma dibujada (pikepdf + Pillow) ---

def _placement(params: Dict[str, Any]) -> Tuple[float, float, float]:
    """Valida y devuelve (x, y, w) normalizados 0-1 (defensa en profundidad)."""
    if params.get('x') is None or params.get('y') is None or params.get('w') is None:
        raise ValueError("Signature placement (x, y, w) is required")
    try:
        x = float(params['x'])
        y = float(params['y'])
        w = float(params['w'])
    except (TypeError, ValueError):
        raise ValueError("Signature placement (x, y, w) must be numbers")
    if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0):
        raise ValueError("Signature position (x, y) must be between 0 and 1")
    if not (0.0 < w <= 1.0):
        raise ValueError("Signature width (w) must be between 0 and 1")
    return x, y, w


def _stamp_drawn_signature(
    input_pdf: Path,
    signature_path: Optional[str],
    pages_spec: Any,
    x: float,
    y: float,
    w: float,
    out_path: Path,
    stamp: Optional[Dict[str, Any]] = None,
) -> None:
    """Estampa la imagen de la firma en las páginas indicadas y escribe out_path.

    (x, y) es la esquina inferior-izquierda del recuadro y w su ancho, todos
    normalizados 0-1 sobre el MediaBox de CADA página (soporta tamaños mixtos).
    La altura se deriva del aspect ratio de la imagen y el recuadro se ajusta
    (clamp) para no salirse de la página.

    Con `stamp`, debajo de la imagen se añade un sello de texto (etiqueta y/o
    fecha-hora) que forma parte del MISMO recuadro: (x, y) es la esquina de todo
    el conjunto, la imagen queda arriba y el sello abajo. El texto va en un
    overlay de reportlab (como en pdf_edit: maneja bien los acentos); sin sello
    el camino es exactamente el de siempre, sin overlay.
    """
    if not signature_path or not Path(signature_path).exists():
        raise ValueError("Signature image not found")

    img = _load_signature_image(signature_path)
    aspect = img.height / img.width  # alto por unidad de ancho
    lines = _stamp_lines(stamp)

    with pikepdf.open(input_pdf) as pdf:
        page_count = len(pdf.pages)
        if pages_spec in (None, '', 'all'):
            indices = list(range(page_count))
        else:
            indices = parse_page_list(pages_spec, page_count, strict=True)

        # La imagen se incrusta UNA sola vez; cada página la referencia.
        xobj = _make_image_xobject(pdf, img)
        for idx in indices:
            page = pdf.pages[idx]
            rect_w, rect_h, px, py, stamp_h = _page_rect(page, x, y, w, aspect, len(lines))
            # add_resource crea /Resources//XObject si falta y genera un nombre
            # único, sin pisar recursos existentes de la página.
            name = page.add_resource(xobj, pikepdf.Name.XObject, prefix='SigImg')
            # Muchos PDFs reales terminan su contenido con un `q` sin cerrar y
            # una CTM activa (visto con los volantes/reportes de la cooperativa:
            # la firma salía encogida o fuera de página). Se envuelve el
            # contenido ORIGINAL en q...Q —lo mismo que hace add_overlay, por
            # eso el sello nunca se desplazaba— para que nuestros operadores
            # partan del estado gráfico inicial de la página.
            page.contents_coalesce()
            page.contents_add(b'q\n', prepend=True)
            # La imagen se apoya SOBRE el sello, de ahí el py + stamp_h.
            ops = (f"\nQ q {rect_w:.4f} 0 0 {rect_h:.4f} {px:.4f} {py + stamp_h:.4f} cm "
                   f"{name} Do Q\n")
            page.contents_add(ops.encode('ascii'))
            if lines:
                _draw_stamp(page, lines, stamp or {}, px, py, rect_w, stamp_h)
        pdf.save(out_path)


def _stamp_lines(stamp: Optional[Dict[str, Any]]) -> List[str]:
    """Líneas del sello: la etiqueta y/o la fecha-hora.

    La fecha se calcula AQUÍ, al procesar el documento, no en el navegador: el
    sello marca cuándo se selló de verdad y no es falseable desde el cliente.
    """
    if not isinstance(stamp, dict):
        return []
    lines: List[str] = []
    text = str(stamp.get('text', '')).replace('\n', ' ').strip()
    if text:
        lines.append(text[:MAX_STAMP_TEXT])
    if stamp.get('show_datetime'):
        fmt = '%d/%m/%Y' if stamp.get('datetime_format') == 'date' else '%d/%m/%Y %H:%M'
        lines.append(datetime.now().strftime(fmt))
    return lines


def _stamp_metrics(rect_w: float, n_lines: int) -> Tuple[float, float, float]:
    """(tamaño de letra, margen interno, alto total) del sello, en puntos."""
    if n_lines <= 0:
        return 0.0, 0.0, 0.0
    font_size = max(STAMP_FONT_MIN, min(rect_w * STAMP_FONT_RATIO, STAMP_FONT_MAX))
    padding = font_size * STAMP_PADDING_RATIO
    height = 2 * padding + n_lines * font_size * STAMP_LEADING
    return font_size, padding, height


def _draw_stamp(page: pikepdf.Page, lines: List[str], stamp: Dict[str, Any],
                px: float, py: float, rect_w: float, stamp_h: float) -> None:
    """Dibuja el sello (borde opcional + líneas centradas) bajo la firma."""
    font_size, padding, _ = _stamp_metrics(rect_w, len(lines))
    color = _stamp_color(stamp.get('color'))

    mb = [float(v) for v in page.mediabox]
    llx, urx = min(mb[0], mb[2]), max(mb[0], mb[2])
    lly, ury = min(mb[1], mb[3]), max(mb[1], mb[3])
    pw, ph = urx - llx, ury - lly

    buf = io.BytesIO()
    pdf_canvas = rl_canvas.Canvas(buf, pagesize=(pw, ph))
    # El overlay se mapea sobre el MediaBox, así que se dibuja desde (0,0).
    ox, oy = px - llx, py - lly

    if stamp.get('border'):
        pdf_canvas.setStrokeColor(color)
        pdf_canvas.setLineWidth(max(0.5, font_size * STAMP_BORDER_RATIO))
        pdf_canvas.rect(ox, oy, rect_w, stamp_h, fill=0, stroke=1)

    pdf_canvas.setFillColor(color)
    pdf_canvas.setFont(STAMP_FONT, font_size)
    # De arriba abajo dentro del recuadro; la primera línea pega con el margen.
    baseline = oy + stamp_h - padding - font_size
    for line in lines:
        pdf_canvas.drawCentredString(ox + rect_w / 2, baseline, _fit_line(line, rect_w, font_size, padding))
        baseline -= font_size * STAMP_LEADING
    pdf_canvas.save()

    with pikepdf.open(io.BytesIO(buf.getvalue())) as overlay:
        rect = pikepdf.Rectangle(llx, lly, llx + pw, lly + ph)
        pikepdf.Page(page).add_overlay(overlay.pages[0], rect)


def _fit_line(line: str, rect_w: float, font_size: float, padding: float) -> str:
    """Recorta la línea con … si no cabe a lo ancho del sello (no se parte)."""
    usable = max(1.0, rect_w - 2 * padding)
    if pdfmetrics.stringWidth(line, STAMP_FONT, font_size) <= usable:
        return line
    out = line
    while out and pdfmetrics.stringWidth(out + '…', STAMP_FONT, font_size) > usable:
        out = out[:-1]
    return out + '…'


def _stamp_color(value: Any) -> colors.Color:
    try:
        return colors.HexColor(str(value))
    except (ValueError, TypeError):
        return colors.HexColor(STAMP_DEFAULT_COLOR)


def _load_signature_image(signature_path: str) -> Image.Image:
    """Decodifica la imagen con Pillow y la valida.

    Solo los píxeles decodificados llegarán al PDF (nunca los bytes del
    usuario), así que cualquier payload del archivo original se descarta.
    """
    try:
        with Image.open(signature_path) as raw:
            raw.load()
            img = raw.convert('RGBA')
    except Image.DecompressionBombError:
        raise ValueError("Signature image has too many pixels")
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ValueError("Signature file is not a valid PNG/JPG image")
    if img.width > MAX_SIGNATURE_WIDTH_PX:
        raise ValueError(
            f"Signature image is too wide ({img.width}px; max {MAX_SIGNATURE_WIDTH_PX}px)"
        )
    return img


def _make_image_xobject(pdf: pikepdf.Pdf, img: Image.Image) -> pikepdf.Object:
    """Crea el XObject de imagen (RGB + SMask con el canal alfa)."""
    rgb = img.convert('RGB')
    alpha = img.getchannel('A')
    smask = pdf.make_stream(
        alpha.tobytes(),
        Type=pikepdf.Name.XObject,
        Subtype=pikepdf.Name.Image,
        Width=img.width,
        Height=img.height,
        ColorSpace=pikepdf.Name.DeviceGray,
        BitsPerComponent=8,
    )
    return pdf.make_stream(
        rgb.tobytes(),
        Type=pikepdf.Name.XObject,
        Subtype=pikepdf.Name.Image,
        Width=img.width,
        Height=img.height,
        ColorSpace=pikepdf.Name.DeviceRGB,
        BitsPerComponent=8,
        SMask=smask,
    )


def _page_rect(page: pikepdf.Page, x: float, y: float, w: float, aspect: float,
               stamp_lines: int = 0) -> Tuple[float, float, float, float, float]:
    """Rect (w, h_imagen, x, y, alto_del_sello) en puntos para ESTA página.

    (x, y) es la esquina inferior-izquierda del CONJUNTO firma+sello y el alto
    total es h_imagen + alto_del_sello; el clamp mantiene todo dentro de la
    página. Sin sello, `stamp_lines=0` deja el comportamiento de siempre.
    """
    mb = [float(v) for v in page.mediabox]
    llx, urx = min(mb[0], mb[2]), max(mb[0], mb[2])
    lly, ury = min(mb[1], mb[3]), max(mb[1], mb[3])
    pw, ph = urx - llx, ury - lly

    rect_w = w * pw
    _, _, stamp_h = _stamp_metrics(rect_w, stamp_lines)
    total_h = rect_w * aspect + stamp_h
    if total_h > ph:
        # No cabe a lo alto: reducir el ancho manteniendo las proporciones. El
        # alto total es proporcional al ancho (la letra del sello también
        # escala con él), así que basta con repartir por el factor.
        rect_w *= ph / total_h
        _, _, stamp_h = _stamp_metrics(rect_w, stamp_lines)
    rect_h = rect_w * aspect
    total_h = rect_h + stamp_h

    px = llx + x * pw
    py = lly + y * ph
    px = max(llx, min(px, urx - rect_w))
    py = max(lly, min(py, ury - total_h))
    return rect_w, rect_h, px, py, stamp_h


# --- Limpieza de artefactos sensibles ---

def _destroy_sign_artifacts(
    cursor,
    job_id: str,
    cert_path: Optional[str] = None,
    signature_path: Optional[str] = None,
) -> None:
    """Borra del disco el .pfx y la imagen de la firma, y elimina sus rutas y
    la contraseña del cert de operation_params (JSON_REMOVE es no-op si la
    clave no existe)."""
    for path in (cert_path, signature_path):
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except OSError:
            pass
    try:
        cursor.execute(
            """
            UPDATE compression_jobs
            SET operation_params = JSON_REMOVE(operation_params,
                '$.cert_password', '$.cert_path', '$.signature_path')
            WHERE id = %s
            """,
            (job_id,),
        )
    except Exception:
        pass
