"""Tests de la firma dibujada/combinada (handle_sign con mode drawn/combined).

No requiere base de datos: se simula el acceso a `files` con FakeCursor y se
redirige OUTPUT_DIR a un directorio temporal.
"""
import datetime
import re
from pathlib import Path

import pikepdf
import pytest
from PIL import Image

from app.config import settings
from app.operations.sign import handle_sign


# --- utilidades ---

class FakeCursor:
    """Cursor mínimo: devuelve los originales en fetchall y captura los execute."""

    def __init__(self, originals):
        self.originals = originals
        self.inserts = []
        self.executed = []  # (sql, params) de TODOS los execute

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        if sql.strip().upper().startswith('INSERT'):
            self.inserts.append(params)

    def fetchall(self):
        return list(self.originals)

    def fetchone(self):
        return self.originals[0] if self.originals else None

    def output_paths(self):
        # register_output inserta: (id, job_id, name, download_name, str(path), size, mime)
        return [Path(p[4]) for p in self.inserts]


def make_pdf(path: Path, pages: int, page_size=(612, 792)) -> None:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=page_size)
    pdf.save(path)


def make_mixed_pdf(path: Path, sizes) -> None:
    pdf = pikepdf.new()
    for size in sizes:
        pdf.add_blank_page(page_size=size)
    pdf.save(path)


def make_signature_png(path: Path, size=(400, 160), transparent=True) -> None:
    """PNG de firma: trazo azul opaco sobre fondo transparente (u opaco)."""
    bg = (0, 0, 0, 0) if transparent else (255, 255, 255, 255)
    img = Image.new('RGBA', size, bg)
    img.paste((0, 0, 200, 255), (size[0] // 8, size[1] // 4,
                                 size[0] * 7 // 8, size[1] * 3 // 4))
    img.save(path)


@pytest.fixture(autouse=True)
def _output_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, 'OUTPUT_DIR', str(tmp_path / 'out'))
    yield


def _original(path: Path, name: str = 'doc.pdf', fid: str = 'f1'):
    return {'id': fid, 'file_path': str(path), 'original_filename': name, 'filename': path.name}


# Operadores que añade _stamp_drawn_signature: q w 0 0 h x y cm /Name Do Q
_STAMP_RE = re.compile(
    rb'q (\d+\.\d+) 0 0 (\d+\.\d+) (\d+\.\d+) (\d+\.\d+) cm (/\S+) Do Q'
)


def _page_content(page) -> bytes:
    contents = page.obj.get('/Contents')
    if contents is None:
        return b''
    if isinstance(contents, pikepdf.Array):
        return b'\n'.join(s.read_bytes() for s in contents)
    return contents.read_bytes()


def _stamp(page):
    """Devuelve (w, h, x, y, nombre) del estampado de la página, o None."""
    m = _STAMP_RE.search(_page_content(page))
    if not m:
        return None
    return (float(m.group(1)), float(m.group(2)),
            float(m.group(3)), float(m.group(4)), m.group(5).decode())


def _run_drawn(tmp_path, pdf_pages=3, page_size=(612, 792), sig_size=(400, 160),
               transparent=True, **params):
    src = tmp_path / 'in.pdf'
    make_pdf(src, pdf_pages, page_size=page_size)
    sig = tmp_path / 'sig.png'
    make_signature_png(sig, size=sig_size, transparent=transparent)
    cur = FakeCursor([_original(src)])
    job_params = {'mode': 'drawn', 'signature_path': str(sig),
                  'pages': '1', 'x': 0.1, 'y': 0.2, 'w': 0.3}
    job_params.update(params)
    handle_sign({'id': 'j1', 'operation_params': job_params}, cur)
    return cur, sig


# --- estampado: páginas ---

def test_drawn_first_page(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=3, pages='1')
    out = pikepdf.open(cur.output_paths()[0])
    # 612x792, x=0.1 y=0.2 w=0.3, aspect 160/400=0.4
    w, h, x, y, _name = _stamp(out.pages[0])
    assert (w, h) == pytest.approx((183.6, 73.44))
    assert (x, y) == pytest.approx((61.2, 158.4))
    assert _stamp(out.pages[1]) is None
    assert _stamp(out.pages[2]) is None


def test_drawn_last_page(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=3, pages='3')
    out = pikepdf.open(cur.output_paths()[0])
    assert _stamp(out.pages[0]) is None
    assert _stamp(out.pages[1]) is None
    assert _stamp(out.pages[2]) is not None


def test_drawn_all_pages(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=4, pages='all')
    out = pikepdf.open(cur.output_paths()[0])
    for page in out.pages:
        assert _stamp(page) is not None


def test_drawn_page_range(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=6, pages='1,3-5')
    out = pikepdf.open(cur.output_paths()[0])
    stamped = [i for i, page in enumerate(out.pages) if _stamp(page) is not None]
    assert stamped == [0, 2, 3, 4]


def test_drawn_mixed_page_sizes(tmp_path):
    """La posición se calcula con el MediaBox de CADA página."""
    src = tmp_path / 'in.pdf'
    make_mixed_pdf(src, [(612, 792), (1000, 500)])
    sig = tmp_path / 'sig.png'
    make_signature_png(sig)  # aspect 0.4
    cur = FakeCursor([_original(src)])
    params = {'mode': 'drawn', 'signature_path': str(sig),
              'pages': 'all', 'x': 0.5, 'y': 0.1, 'w': 0.2}
    handle_sign({'id': 'j1', 'operation_params': params}, cur)

    out = pikepdf.open(cur.output_paths()[0])
    w1, h1, x1, y1, _ = _stamp(out.pages[0])
    assert (w1, h1) == pytest.approx((122.4, 48.96))
    assert (x1, y1) == pytest.approx((306.0, 79.2))
    w2, h2, x2, y2, _ = _stamp(out.pages[1])
    assert (w2, h2) == pytest.approx((200.0, 80.0))
    assert (x2, y2) == pytest.approx((500.0, 50.0))


# --- estampado: esquinas y clamp ---

@pytest.mark.parametrize('cx,cy,ex,ey', [
    (0.0, 0.0, 0.0, 0.0),          # inferior-izquierda
    (1.0, 0.0, 612 - 183.6, 0.0),  # inferior-derecha: clamp horizontal
    (0.0, 1.0, 0.0, 792 - 73.44),  # superior-izquierda: clamp vertical
    (1.0, 1.0, 612 - 183.6, 792 - 73.44),  # superior-derecha: ambos
])
def test_drawn_corners_clamped(tmp_path, cx, cy, ex, ey):
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1', x=cx, y=cy, w=0.3)
    out = pikepdf.open(cur.output_paths()[0])
    w, h, x, y, _name = _stamp(out.pages[0])
    assert (w, h) == pytest.approx((183.6, 73.44))
    assert (x, y) == pytest.approx((ex, ey))


def test_drawn_clamp_oversize_height(tmp_path):
    """Imagen muy vertical con w=1: la altura no cabe y se reduce con aspecto."""
    # aspect = 400/100 = 4 -> rect_h teórico 612*4 = 2448 > 792
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1',
                        sig_size=(100, 400), x=1.0, y=1.0, w=1.0)
    out = pikepdf.open(cur.output_paths()[0])
    w, h, x, y, _name = _stamp(out.pages[0])
    assert h == pytest.approx(792.0)
    assert w == pytest.approx(198.0)  # 792 / 4
    assert x == pytest.approx(612 - 198.0)
    assert y == pytest.approx(0.0)


def test_drawn_survives_dirty_graphics_state(tmp_path):
    """Regresión (volantes/reportes de la cooperativa): el contenido del PDF
    termina con un `q` sin cerrar y una CTM activa (escala+traslación). La
    firma debe caer EXACTAMENTE donde se colocó, no heredar esa matriz —
    antes salía encogida o directamente fuera de la página.

    Se mide el resultado RENDERIZADO (fitz), no los operadores crudos: el bug
    estaba en la matriz efectiva, no en los números de nuestro `cm`.
    """
    import fitz

    src = tmp_path / 'in.pdf'
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.contents_add(b'q 0.75 0 0 0.75 50 100 cm 0 0 1 rg 0 0 10 10 re f\n')
    pdf.save(src)
    sig = tmp_path / 'sig.png'
    make_signature_png(sig)  # 400x160 -> aspect 0.4
    cur = FakeCursor([_original(src)])
    handle_sign({'id': 'j1', 'operation_params': {
        'mode': 'drawn', 'signature_path': str(sig),
        'pages': '1', 'x': 0.5, 'y': 0.5, 'w': 0.2}}, cur)

    doc = fitz.open(str(cur.output_paths()[0]))
    page_out = doc[0]
    rects = [r for info in page_out.get_images(full=True)
             for r in page_out.get_image_rects(info[0])]
    doc.close()

    assert len(rects) == 1
    r = rects[0]
    assert r.x0 == pytest.approx(0.5 * 612, abs=0.5)
    assert 792 - r.y1 == pytest.approx(0.5 * 792, abs=0.5)  # sin sello: base = y
    assert r.width == pytest.approx(0.2 * 612, abs=0.5)
    assert r.height == pytest.approx(0.2 * 612 * 0.4, abs=0.5)


# --- imagen: transparencia y validaciones ---

def test_drawn_transparent_png_has_smask(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1', transparent=True)
    out = pikepdf.open(cur.output_paths()[0])
    page = out.pages[0]
    name = _stamp(page)[4]
    xobj = page.obj['/Resources']['/XObject'][name]
    assert xobj['/Subtype'] == pikepdf.Name.Image
    assert '/SMask' in xobj
    smask = xobj['/SMask']
    assert smask['/ColorSpace'] == pikepdf.Name.DeviceGray


def test_drawn_invalid_image_rejected(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    fake = tmp_path / 'sig.png'
    fake.write_bytes(b'no soy una imagen ni de lejos')
    cur = FakeCursor([_original(src)])
    params = {'mode': 'drawn', 'signature_path': str(fake),
              'pages': '1', 'x': 0.1, 'y': 0.1, 'w': 0.3}
    with pytest.raises(ValueError, match='not a valid'):
        handle_sign({'id': 'j1', 'operation_params': params}, cur)
    assert not fake.exists()  # la limpieza corre también en fallo


def test_drawn_too_wide_rejected(tmp_path):
    with pytest.raises(ValueError, match='too wide'):
        _run_drawn(tmp_path, pdf_pages=1, pages='1', sig_size=(2001, 50))


def test_drawn_page_out_of_range(tmp_path):
    with pytest.raises(ValueError, match='out of range'):
        _run_drawn(tmp_path, pdf_pages=3, pages='99')


@pytest.mark.parametrize('bad', [
    {'x': None}, {'x': 1.5}, {'y': -0.1}, {'w': 0}, {'w': 1.2}, {'x': 'abc'},
])
def test_drawn_bad_placement(tmp_path, bad):
    with pytest.raises(ValueError):
        _run_drawn(tmp_path, pdf_pages=1, pages='1', **bad)


def test_drawn_missing_signature_file(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    cur = FakeCursor([_original(src)])
    params = {'mode': 'drawn', 'signature_path': str(tmp_path / 'nope.png'),
              'pages': '1', 'x': 0.1, 'y': 0.1, 'w': 0.3}
    with pytest.raises(ValueError, match='Signature image not found'):
        handle_sign({'id': 'j1', 'operation_params': params}, cur)


# --- certificado de prueba para combined/retrocompat ---

PFX_PASSWORD = 'clave-de-prueba'


@pytest.fixture(scope='session')
def pfx_and_cert():
    """(bytes .pfx, certificado) autofirmado generado con cryptography."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Firmante de Prueba')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=365))
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, content_commitment=True,
                key_encipherment=False, data_encipherment=False,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )
    pfx = pkcs12.serialize_key_and_certificates(
        b'test', key, cert, None,
        serialization.BestAvailableEncryption(PFX_PASSWORD.encode()),
    )
    return pfx, cert


def _write_pfx(tmp_path, pfx_bytes) -> Path:
    # Cada test necesita su copia: el job la destruye al terminar.
    path = tmp_path / 'cert.pfx'
    path.write_bytes(pfx_bytes)
    return path


def _validate_signature(pdf_path: Path, cert) -> None:
    """La firma criptográfica del PDF debe ser íntegra y válida."""
    from asn1crypto import x509 as asn1x509
    from cryptography.hazmat.primitives.serialization import Encoding
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.sign.validation import validate_pdf_signature
    from pyhanko_certvalidator import ValidationContext

    root = asn1x509.Certificate.load(cert.public_bytes(Encoding.DER))
    vc = ValidationContext(trust_roots=[root], allow_fetching=False)
    with open(pdf_path, 'rb') as f:
        reader = PdfFileReader(f)
        assert len(reader.embedded_signatures) == 1
        status = validate_pdf_signature(reader.embedded_signatures[0], vc)
    assert status.intact
    assert status.valid


# --- modo combinado ---

def test_combined_stamps_and_signs(tmp_path, pfx_and_cert):
    pfx_bytes, cert = pfx_and_cert
    src = tmp_path / 'in.pdf'
    make_pdf(src, 2)
    sig = tmp_path / 'sig.png'
    make_signature_png(sig)
    pfx = _write_pfx(tmp_path, pfx_bytes)

    cur = FakeCursor([_original(src)])
    params = {
        'mode': 'combined', 'signature_path': str(sig),
        'pages': 'all', 'x': 0.6, 'y': 0.05, 'w': 0.25,
        'cert_path': str(pfx), 'cert_password': PFX_PASSWORD,
        'reason': 'Prueba combinada',
    }
    handle_sign({'id': 'j1', 'operation_params': params}, cur)

    out_path = cur.output_paths()[0]
    _validate_signature(out_path, cert)
    out = pikepdf.open(out_path)
    for page in out.pages:
        assert _stamp(page) is not None
    # el temporal estampado se borró
    assert not list(out_path.parent.glob('stamped_*'))


def test_combined_cleans_up_both_artifacts(tmp_path, pfx_and_cert):
    pfx_bytes, _cert = pfx_and_cert
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    sig = tmp_path / 'sig.png'
    make_signature_png(sig)
    pfx = _write_pfx(tmp_path, pfx_bytes)

    cur = FakeCursor([_original(src)])
    params = {
        'mode': 'combined', 'signature_path': str(sig),
        'pages': '1', 'x': 0.1, 'y': 0.1, 'w': 0.3,
        'cert_path': str(pfx), 'cert_password': PFX_PASSWORD,
    }
    handle_sign({'id': 'j1', 'operation_params': params}, cur)

    assert not sig.exists()
    assert not pfx.exists()
    removes = [sql for sql, _ in cur.executed if 'JSON_REMOVE' in sql]
    assert len(removes) == 1
    assert "'$.cert_password'" in removes[0]
    assert "'$.cert_path'" in removes[0]
    assert "'$.signature_path'" in removes[0]
    assert cur.executed[-2][1] == ('j1',)  # el UPDATE lleva el job id


# --- retrocompatibilidad y limpieza en drawn ---

def test_no_mode_defaults_to_certificate(tmp_path, pfx_and_cert):
    """Jobs sin `mode` siguen firmando con certificado como hasta ahora."""
    pfx_bytes, cert = pfx_and_cert
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    pfx = _write_pfx(tmp_path, pfx_bytes)

    cur = FakeCursor([_original(src)])
    params = {'cert_path': str(pfx), 'cert_password': PFX_PASSWORD}
    result = handle_sign({'id': 'j1', 'operation_params': params}, cur)

    assert result == {'files_output': 1}
    assert cur.inserts[0][3] == 'doc_signed.pdf'
    _validate_signature(cur.output_paths()[0], cert)
    assert not pfx.exists()


def test_unknown_mode_rejected(tmp_path):
    src = tmp_path / 'in.pdf'
    make_pdf(src, 1)
    cur = FakeCursor([_original(src)])
    with pytest.raises(ValueError, match='Unknown sign mode'):
        handle_sign({'id': 'j1', 'operation_params': {'mode': 'telepathic'}}, cur)


def test_drawn_cleanup_removes_image_and_params(tmp_path):
    cur, sig = _run_drawn(tmp_path, pdf_pages=1, pages='1')
    assert not sig.exists()
    removes = [(sql, p) for sql, p in cur.executed if 'JSON_REMOVE' in sql]
    assert len(removes) == 1
    assert "'$.signature_path'" in removes[0][0]
    assert removes[0][1] == ('j1',)


def test_drawn_custom_output_name(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1',
                        output_name='contrato firmado')
    assert cur.inserts[0][3] == 'contrato firmado.pdf'


# --- sello de texto bajo la firma ---

def _overlay_content(page) -> str:
    """Contenido de los Form XObject de la página (donde va el sello)."""
    resources = page.obj.get('/Resources')
    xobjects = resources.get('/XObject') if resources is not None else None
    if xobjects is None:
        return ''
    blobs = []
    for key in xobjects.keys():
        xobj = xobjects[key]
        if xobj.get('/Subtype') == pikepdf.Name.Form:
            blobs.append(bytes(xobj.read_bytes()))
    return b'\n'.join(blobs).decode('latin-1')


def _overlay_texts(page):
    """Cadenas dibujadas en el sello, en orden."""
    return re.findall(r'\((.*?)\)\s*Tj', _overlay_content(page))


def _first_page(cur):
    """Primera página del PDF de salida.

    Devuelve también el Pdf: si no se retiene, pikepdf lo cierra al recolectarlo
    y la página queda inutilizable ("Object was inside a closed Pdf").
    """
    pdf = pikepdf.open(cur.output_paths()[0])
    return pdf, pdf.pages[0]


def _subdir(tmp_path, name):
    """Subcarpeta propia para poder correr dos estampados en el mismo test."""
    path = tmp_path / name
    path.mkdir(parents=True, exist_ok=True)
    return path


def test_stamp_draws_label_and_datetime(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1',
                        stamp={'text': 'AUTORIZADO', 'show_datetime': True})
    out = pikepdf.open(cur.output_paths()[0])
    texts = _overlay_texts(out.pages[0])
    assert texts[0] == 'AUTORIZADO'
    # La fecha la pone el worker al procesar, no el navegador.
    assert texts[1] == datetime.datetime.now().strftime('%d/%m/%Y %H:%M')


def test_stamp_date_only_format(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1',
                        stamp={'show_datetime': True, 'datetime_format': 'date'})
    _pdf, page = _first_page(cur)
    assert _overlay_texts(page) == [datetime.datetime.now().strftime('%d/%m/%Y')]


def test_stamp_lifts_the_image_and_keeps_the_unit_inside_the_page(tmp_path):
    """(x,y) es la esquina del CONJUNTO: la imagen sube el alto del sello."""
    sin_sello, _ = _run_drawn(_subdir(tmp_path, 'a'), pdf_pages=1, pages='1', x=0.1, y=0.0, w=0.3)
    con_sello, _ = _run_drawn(_subdir(tmp_path, 'b'), pdf_pages=1, pages='1', x=0.1, y=0.0, w=0.3,
                              stamp={'text': 'AUTORIZADO', 'show_datetime': True})
    _p0, page0 = _first_page(sin_sello)
    _p1, page1 = _first_page(con_sello)
    w0, h0, x0, y0, _ = _stamp(page0)
    w1, h1, x1, y1, _ = _stamp(page1)

    # Misma imagen y misma x; la y sube exactamente el alto del sello.
    assert (w1, h1, x1) == pytest.approx((w0, h0, x0))
    # 2 líneas: 2*padding + 2*leading*font, con font = 0.11*183.6 = 20.196
    font = 183.6 * 0.11
    assert y1 - y0 == pytest.approx(2 * font * 0.4 + 2 * font * 1.3)


def test_stamp_clamped_at_the_top_of_the_page(tmp_path):
    """Con y=1 el conjunto entero (imagen + sello) sigue dentro de la página."""
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1', x=0.0, y=1.0, w=0.3,
                        stamp={'text': 'CANCELADO', 'show_datetime': True})
    _pdf, page = _first_page(cur)
    _w, h, _x, y, _n = _stamp(page)
    assert y + h == pytest.approx(792.0)  # la imagen toca el borde superior


def test_stamp_long_text_is_truncated_with_ellipsis(tmp_path):
    largo = 'AUTORIZADO POR LA GERENCIA GENERAL DE OPERACIONES'
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1', w=0.2, stamp={'text': largo})
    _pdf, page = _first_page(cur)
    texts = _overlay_texts(page)
    assert texts[0].endswith('\\205')  # … escapado en WinAnsi por reportlab
    assert len(texts[0]) < len(largo)


def test_stamp_absent_leaves_the_page_without_overlay(tmp_path):
    """Sin sello no se toca nada del camino de siempre: ni overlay ni cambios."""
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1')
    _pdf, page = _first_page(cur)
    assert _overlay_content(page) == ''


def test_stamp_empty_text_without_datetime_is_ignored(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1', stamp={'text': '   '})
    _pdf, page = _first_page(cur)
    assert _overlay_content(page) == ''


def test_stamp_border_is_drawn_when_requested(tmp_path):
    con, _ = _run_drawn(_subdir(tmp_path, 'a'), pdf_pages=1, pages='1',
                        stamp={'text': 'ANULADO', 'border': True})
    sin, _ = _run_drawn(_subdir(tmp_path, 'b'), pdf_pages=1, pages='1',
                        stamp={'text': 'ANULADO', 'border': False})
    _p1, con_page = _first_page(con)
    _p2, sin_page = _first_page(sin)
    assert ' re' in _overlay_content(con_page)
    assert ' re' not in _overlay_content(sin_page)


def test_stamp_accents_survive(tmp_path):
    cur, _ = _run_drawn(tmp_path, pdf_pages=1, pages='1', w=0.5,
                        stamp={'text': 'RECIBIÓ: José Ñ'})
    _pdf, page = _first_page(cur)
    content = _overlay_content(page)
    assert '\\323' in content  # Ó en WinAnsi (octal 323)
    assert '\\321' in content  # Ñ
