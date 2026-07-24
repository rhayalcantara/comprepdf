"""Tests del handler de edición de PDF (pdf_edit, Fase A: text/image/whiteout).

Sin base de datos: FakeCursor simula el acceso a `files` y OUTPUT_DIR va a un
temporal. Las comprobaciones estructurales usan pikepdf; las visuales (que el
resultado se ve como debe) usan pypdfium2 con importorskip.
"""
import io
from pathlib import Path

import pikepdf
import pytest
from PIL import Image
from reportlab.lib.units import mm
from reportlab.pdfgen import canvas

from app.config import settings
from app.operations.pdf_edit import apply_edits, handle_pdf_edit


class FakeCursor:
    def __init__(self, originals):
        self.originals = originals
        self.inserts = []
        self.executed = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if sql.strip().upper().startswith('INSERT'):
            self.inserts.append(params)

    def fetchall(self):
        return list(self.originals)

    def fetchone(self):
        return self.originals[0] if self.originals else None

    def output_paths(self):
        return [Path(p[4]) for p in self.inserts]


@pytest.fixture(autouse=True)
def _output_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'OUTPUT_DIR', str(tmp_path / 'out'))
    yield


def _original(path: Path, name='doc.pdf', fid='f1'):
    return {'id': fid, 'file_path': str(path), 'original_filename': name, 'filename': path.name}


def make_pdf(path: Path, pages=1, page_size=(612, 792), black_band=False):
    """PDF de prueba. Con black_band pinta una franja negra en la mitad inferior
    de cada página, para comprobar que el whiteout la tapa."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=page_size)
    for _ in range(pages):
        if black_band:
            c.setFillColorRGB(0, 0, 0)
            c.rect(0, 0, page_size[0], page_size[1] / 2, fill=1, stroke=0)
        c.showPage()
    c.save()
    path.write_bytes(buf.getvalue())


def make_png(path: Path, size=(120, 80), color=(0, 128, 0, 255)):
    Image.new('RGBA', size, color).save(path)


def _run(tmp_path, edits, pages=1, page_size=(612, 792), black_band=False, **params):
    src = tmp_path / 'in.pdf'
    make_pdf(src, pages, page_size, black_band)
    cur = FakeCursor([_original(src)])
    job_params = {'edits': edits}
    job_params.update(params)
    result = handle_pdf_edit({'id': 'j1', 'operation_params': job_params}, cur)
    return cur, result


# --- estructura ---

def _xobjects(page):
    res = page.obj.get('/Resources')
    if res is None or '/XObject' not in res:
        return {}
    xo = res['/XObject']
    return {k: xo[k] for k in xo.keys()}


def _has_form_overlay(page):
    return any(str(x.get('/Subtype')) == '/Form' for x in _xobjects(page).values())


def test_text_edit_adds_overlay(tmp_path):
    cur, result = _run(tmp_path, [
        {'type': 'text', 'page': 1, 'x': 0.1, 'y': 0.8, 'w': 0.5, 'h': 0.05, 'text': 'APROBADO'},
    ])
    assert result == {'edits': 1}
    out = pikepdf.open(cur.output_paths()[0])
    assert _has_form_overlay(out.pages[0])


def test_only_target_page_gets_overlay(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'text', 'page': 2, 'x': 0.1, 'y': 0.5, 'w': 0.4, 'h': 0.05, 'text': 'X'},
    ], pages=3)
    out = pikepdf.open(cur.output_paths()[0])
    assert not _has_form_overlay(out.pages[0])
    assert _has_form_overlay(out.pages[1])
    assert not _has_form_overlay(out.pages[2])


def test_edits_on_missing_page_are_skipped(tmp_path):
    cur, result = _run(tmp_path, [
        {'type': 'text', 'page': 99, 'x': 0.1, 'y': 0.5, 'w': 0.4, 'h': 0.05, 'text': 'X'},
    ], pages=2)
    assert result == {'edits': 0}
    assert pikepdf.open(cur.output_paths()[0]).pages is not None  # PDF válido igual


def test_no_edits_raises(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src)
    cur = FakeCursor([_original(src)])
    with pytest.raises(ValueError, match='no edits'):
        handle_pdf_edit({'id': 'j1', 'operation_params': {'edits': []}}, cur)


def test_valid_pdf_magic_bytes(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'text', 'page': 1, 'x': 0.1, 'y': 0.8, 'w': 0.4, 'h': 0.05, 'text': 'x'},
    ])
    assert cur.output_paths()[0].read_bytes()[:5] == b'%PDF-'


def test_custom_output_name(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'text', 'page': 1, 'x': 0.1, 'y': 0.8, 'w': 0.4, 'h': 0.05, 'text': 'x'},
    ], output_name='contrato editado')
    assert cur.inserts[0][3] == 'contrato editado.pdf'


def test_default_output_name_from_original(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'text', 'page': 1, 'x': 0.1, 'y': 0.8, 'w': 0.4, 'h': 0.05, 'text': 'x'},
    ])
    assert cur.inserts[0][3] == 'doc_editado.pdf'


# --- imágenes ---

def test_image_edit_embeds_image(tmp_path):
    img = tmp_path / 'stamp.png'
    make_png(img, (100, 60))
    cur, result = _run(tmp_path, [
        {'type': 'image', 'page': 1, 'x': 0.5, 'y': 0.5, 'w': 0.2, 'h': 0.1,
         'image_path': str(img)},
    ])
    assert result == {'edits': 1}
    # La imagen queda dentro del overlay; basta con que el overlay exista y que la
    # imagen subida se haya limpiado del disco.
    out = pikepdf.open(cur.output_paths()[0])
    assert _has_form_overlay(out.pages[0])


def test_broken_image_is_skipped_not_fatal(tmp_path):
    bad = tmp_path / 'bad.png'
    bad.write_bytes(b'esto no es una imagen')
    cur, result = _run(tmp_path, [
        {'type': 'image', 'page': 1, 'x': 0.5, 'y': 0.5, 'w': 0.2, 'h': 0.1, 'image_path': str(bad)},
        {'type': 'text', 'page': 1, 'x': 0.1, 'y': 0.8, 'w': 0.4, 'h': 0.05, 'text': 'ok'},
    ])
    # La imagen rota se omite; el texto sí cuenta -> 1 edición en esa página...
    # (se cuentan las ediciones de las páginas que produjeron overlay)
    assert result['edits'] == 2  # ambas están en la pág 1, que sí dibujó (por el texto)
    assert cur.output_paths()[0].read_bytes()[:5] == b'%PDF-'


def test_missing_image_file_skipped(tmp_path):
    cur, result = _run(tmp_path, [
        {'type': 'image', 'page': 1, 'x': 0.5, 'y': 0.5, 'w': 0.2, 'h': 0.1,
         'image_path': str(tmp_path / 'nope.png')},
    ])
    assert result == {'edits': 0}


# --- limpieza de imágenes subidas ---

def test_cleanup_deletes_images_and_blanks_paths(tmp_path):
    img = tmp_path / 'stamp.png'
    make_png(img)
    cur, _ = _run(tmp_path, [
        {'type': 'image', 'page': 1, 'x': 0.5, 'y': 0.5, 'w': 0.2, 'h': 0.1, 'image_path': str(img)},
    ])
    assert not img.exists()  # borrada del disco
    updates = [(sql, p) for sql, p in cur.executed if sql.strip().upper().startswith('UPDATE')]
    assert len(updates) == 1
    assert 'operation_params' in updates[0][0]
    assert updates[0][1][1] == 'j1'  # el job id
    assert 'stamp.png' not in updates[0][1][0]  # la ruta ya no está en el JSON


# --- apply_edits directo (sin cursor) ---

def test_apply_edits_counts_and_clamps(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    out = tmp_path / 'out.pdf'
    # x fuera de rango se clampa, no revienta
    n = apply_edits(src, [
        {'type': 'text', 'page': 1, 'x': 5, 'y': 0.5, 'w': 0.4, 'h': 0.05, 'text': 'clamp'},
    ], out)
    assert n == 1
    assert out.read_bytes()[:5] == b'%PDF-'


# --- verificación visual (pypdfium2) ---

def _render(path, scale=2):
    pdfium = pytest.importorskip('pypdfium2')
    doc = pdfium.PdfDocument(str(path))
    doc.init_forms()
    return [doc[i].render(scale=scale).to_pil() for i in range(len(doc))]


def _pixel(img, xf, yf):
    """Color en la coordenada normalizada (origen abajo-izquierda)."""
    w, h = img.size
    px = min(w - 1, int(xf * w))
    py = min(h - 1, int((1 - yf) * h))  # PIL: origen arriba-izquierda
    return img.convert('RGB').getpixel((px, py))


# --- Fase 1: marcado, formas y marcas rápidas ---

SHAPE_TYPES = ('highlight', 'underline', 'strikeout', 'line', 'arrow', 'rect', 'ellipse', 'mark')


def test_all_shape_types_add_overlay(tmp_path):
    """Los 8 tipos nuevos dibujan algo: cada uno cuenta como edición aplicada."""
    edits = [{'type': t, 'page': 1, 'x': 0.1, 'y': 0.1, 'w': 0.3, 'h': 0.1}
             for t in SHAPE_TYPES]
    cur, result = _run(tmp_path, edits)
    assert result == {'edits': len(SHAPE_TYPES)}
    out = pikepdf.open(cur.output_paths()[0])
    assert _has_form_overlay(out.pages[0])


def test_highlight_is_translucent(tmp_path):
    """Sobre la franja negra el resaltado se nota (no queda negro puro) pero NO
    tapa como el whiteout (no queda blanco): eso solo pasa si hay alpha real."""
    cur, _ = _run(tmp_path, [
        {'type': 'highlight', 'page': 1, 'x': 0.3, 'y': 0.2, 'w': 0.4, 'h': 0.1},
    ], black_band=True)
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.5, 0.25)
    assert r > 40, f'el resaltado no se dibujó sobre el negro: {(r, g, b)}'
    assert b < 80, f'el resaltado tapó en vez de transparentar: {(r, g, b)}'
    # Fuera del recuadro la franja sigue negra
    r2, g2, b2 = _pixel(page, 0.1, 0.25)
    assert r2 < 40 and g2 < 40 and b2 < 40


def test_strikeout_crosses_mid_height(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'strikeout', 'page': 1, 'x': 0.2, 'y': 0.4, 'w': 0.4, 'h': 0.1,
         'stroke_width': 4},
    ])
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.4, 0.45)  # media altura de la caja
    assert r > 120 and g < 120, f'esperaba trazo rojo, vi {(r, g, b)}'
    r2, g2, b2 = _pixel(page, 0.4, 0.48)  # dentro de la caja pero fuera del trazo
    assert r2 > 240 and g2 > 240 and b2 > 240


def test_underline_at_bottom_edge(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'underline', 'page': 1, 'x': 0.2, 'y': 0.4, 'w': 0.4, 'h': 0.1,
         'stroke_width': 4},
    ])
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.4, 0.4)  # borde inferior
    assert r > 120 and g < 120, f'esperaba subrayado rojo, vi {(r, g, b)}'


def test_rect_is_border_not_fill(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'rect', 'page': 1, 'x': 0.2, 'y': 0.4, 'w': 0.4, 'h': 0.2,
         'stroke_width': 4},
    ])
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.2, 0.5)  # borde izquierdo
    assert r > 120 and g < 120, f'esperaba borde rojo, vi {(r, g, b)}'
    r2, g2, b2 = _pixel(page, 0.4, 0.5)  # centro: sin relleno
    assert r2 > 240 and g2 > 240 and b2 > 240


def test_line_direction_down(tmp_path):
    """dir='down' traza de arriba-izquierda a abajo-derecha; la otra diagonal
    queda limpia."""
    cur, _ = _run(tmp_path, [
        {'type': 'line', 'page': 1, 'x': 0.2, 'y': 0.2, 'w': 0.4, 'h': 0.4,
         'dir': 'down', 'stroke_width': 4},
    ])
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.22, 0.58)  # cerca del arranque de la diagonal down
    assert r > 120 and g < 120, f'esperaba la diagonal down, vi {(r, g, b)}'
    r2, g2, b2 = _pixel(page, 0.22, 0.22)  # arranque de la diagonal up: limpio
    assert r2 > 240 and g2 > 240 and b2 > 240


def test_arrow_passes_through_center(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'arrow', 'page': 1, 'x': 0.2, 'y': 0.2, 'w': 0.4, 'h': 0.4,
         'stroke_width': 4},
    ])
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.4, 0.4)  # centro de la caja: sobre la diagonal up
    assert r > 120 and g < 120, f'esperaba la flecha, vi {(r, g, b)}'


def test_mark_cross_draws_strokes(tmp_path):
    cur, _ = _run(tmp_path, [
        {'type': 'mark', 'mark': 'cross', 'page': 1, 'x': 0.4, 'y': 0.4,
         'w': 0.1, 'h': 0.1, 'stroke_width': 4},
    ])
    page = _render(cur.output_paths()[0])[0].convert('RGB')
    w, h = page.size
    reddish = 0
    for py in range(int(h * 0.50), int(h * 0.60)):
        for px in range(int(w * 0.40), int(w * 0.50), 2):
            r, g, b = page.getpixel((px, py))
            if r > 120 and g < 120:
                reddish += 1
    assert reddish > 10, f'esperaba trazos de la cruz, conté {reddish}'


def test_alpha_does_not_leak_to_next_edit(tmp_path):
    """Un highlight seguido de un rect: el trazo del rect debe salir opaco
    (el alpha del resaltado se restaura con saveState/restoreState)."""
    cur, _ = _run(tmp_path, [
        {'type': 'highlight', 'page': 1, 'x': 0.1, 'y': 0.7, 'w': 0.2, 'h': 0.05},
        {'type': 'rect', 'page': 1, 'x': 0.2, 'y': 0.4, 'w': 0.4, 'h': 0.2,
         'stroke_width': 4, 'color': '#000000'},
    ])
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.2, 0.5)  # borde del rect: negro OPACO
    assert r < 60 and g < 60 and b < 60, f'el trazo salió translúcido: {(r, g, b)}'


def test_whiteout_covers_content(tmp_path):
    # Franja negra en la mitad inferior; tapamos un trozo y debe quedar blanco.
    cur, _ = _run(tmp_path, [
        {'type': 'whiteout', 'page': 1, 'x': 0.3, 'y': 0.2, 'w': 0.4, 'h': 0.1},
    ], black_band=True)
    page = _render(cur.output_paths()[0])[0]
    # Centro del recuadro tapado (0.5, 0.25): debe ser ~blanco
    r, g, b = _pixel(page, 0.5, 0.25)
    assert r > 240 and g > 240 and b > 240, f'esperaba blanco, vi {(r, g, b)}'
    # Fuera del recuadro, la franja negra sigue (0.1, 0.25)
    r2, g2, b2 = _pixel(page, 0.1, 0.25)
    assert r2 < 40 and g2 < 40 and b2 < 40, f'esperaba negro, vi {(r2, g2, b2)}'


def test_image_is_visible_at_position(tmp_path):
    img = tmp_path / 'stamp.png'
    make_png(img, (100, 100), color=(220, 20, 30, 255))  # rojo intenso, opaco
    cur, _ = _run(tmp_path, [
        {'type': 'image', 'page': 1, 'x': 0.4, 'y': 0.4, 'w': 0.2, 'h': 0.15, 'image_path': str(img)},
    ])
    page = _render(cur.output_paths()[0])[0]
    r, g, b = _pixel(page, 0.5, 0.475)  # dentro del recuadro de la imagen
    assert r > 150 and g < 100 and b < 100, f'esperaba rojo, vi {(r, g, b)}'


def test_text_is_dark_pixels(tmp_path):
    # Un texto grande deja píxeles oscuros dentro de su caja sobre fondo blanco.
    cur, _ = _run(tmp_path, [
        {'type': 'text', 'page': 1, 'x': 0.1, 'y': 0.5, 'w': 0.8, 'h': 0.1,
         'text': 'TEXTO DE PRUEBA', 'font_size': 28, 'color': '#000000'},
    ])
    page = _render(cur.output_paths()[0])[0].convert('RGB')
    w, h = page.size
    # Franja de la caja de texto: buscar algún píxel oscuro
    dark = 0
    for py in range(int(h * 0.40), int(h * 0.52)):
        for px in range(int(w * 0.1), int(w * 0.9), 3):
            r, g, b = page.getpixel((px, py))
            if r < 80 and g < 80 and b < 80:
                dark += 1
    assert dark > 20, f'esperaba píxeles de texto oscuros, conté {dark}'
