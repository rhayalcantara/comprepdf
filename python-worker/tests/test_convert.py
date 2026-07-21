"""Tests de la operación convert (Office/imagen → PDF).

Dos niveles:
  - Unit (siempre): despacho por extensión, imagen→PDF con Pillow, validación
    de la salida. Corren en cualquier host, sin Office.
  - Integración COM (solo con Office instalado y registrado): conversión real
    de docx/xlsx/pptx generados en el propio test. En CI/Linux se saltan.
"""
import shutil
from pathlib import Path

import pikepdf
import pytest
from PIL import Image

from app.config import settings
from app.operations import convert as convert_op
from app.operations.convert import handle_convert
from app.converters.image_pdf import convert_image
from app.converters import office_com


# --- utilidades ---

class FakeCursor:
    def __init__(self, originals):
        self.originals = originals
        self.inserts = []

    def execute(self, sql, params=None):
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


def _original(path: Path, name: str):
    return {'id': 'f1', 'file_path': str(path), 'original_filename': name,
            'filename': path.name}


def _office_registered(progid: str) -> bool:
    """¿Está la aplicación COM registrada en este host?"""
    if not office_com.COM_AVAILABLE:
        return False
    import winreg
    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, progid))
        return True
    except OSError:
        return False


needs_word = pytest.mark.skipif(not _office_registered('Word.Application'),
                                reason='Word COM no disponible')
needs_excel = pytest.mark.skipif(not _office_registered('Excel.Application'),
                                 reason='Excel COM no disponible')
needs_ppt = pytest.mark.skipif(not _office_registered('PowerPoint.Application'),
                               reason='PowerPoint COM no disponible')


# --- despacho por extensión (sin Office: se monkeypatchean los conversores) ---

@pytest.mark.parametrize('name,converter', [
    ('doc.docx', 'convert_word'),
    ('viejo.DOC', 'convert_word'),
    ('notas.txt', 'convert_word'),
    ('libro.xlsx', 'convert_excel'),
    ('hoja.ods', 'convert_excel'),
    ('charla.pptx', 'convert_powerpoint'),
])
def test_dispatch_by_extension(tmp_path, monkeypatch, name, converter):
    src = tmp_path / 'in.bin'
    src.write_bytes(b'x')
    called = {}

    def fake(input_path, output_path):
        called['converter'] = converter
        output_path.write_bytes(b'%PDF-1.4 fake')

    for c in ('convert_word', 'convert_excel', 'convert_powerpoint'):
        monkeypatch.setattr(convert_op, c,
                            fake if c == converter else _must_not_run(c))
    cur = FakeCursor([_original(src, name)])
    result = handle_convert({'id': 'j1', 'operation_params': {}}, cur)

    assert called['converter'] == converter
    assert result['source_format'] == Path(name).suffix.lower().lstrip('.')


def _must_not_run(name):
    def fail(*args):
        raise AssertionError(f'{name} no debía ejecutarse')
    return fail


def test_unsupported_extension_rejected(tmp_path):
    src = tmp_path / 'in.bin'
    src.write_bytes(b'x')
    cur = FakeCursor([_original(src, 'programa.exe')])
    with pytest.raises(ValueError, match='Unsupported file type'):
        handle_convert({'id': 'j1', 'operation_params': {}}, cur)


def test_empty_output_rejected(tmp_path, monkeypatch):
    """Una conversión que "termina" sin dejar un PDF válido es un error."""
    src = tmp_path / 'in.docx'
    src.write_bytes(b'x')
    monkeypatch.setattr(convert_op, 'convert_word',
                        lambda i, o: o.write_bytes(b'no soy un pdf'))
    cur = FakeCursor([_original(src, 'doc.docx')])
    with pytest.raises(ValueError, match='valid PDF'):
        handle_convert({'id': 'j1', 'operation_params': {}}, cur)


def test_custom_output_name(tmp_path, monkeypatch):
    src = tmp_path / 'in.png'
    Image.new('RGB', (10, 10), (200, 30, 30)).save(src)
    cur = FakeCursor([_original(src, 'foto.png')])
    handle_convert({'id': 'j1', 'operation_params': {'output_name': 'mi foto'}}, cur)
    assert cur.output_paths()[0].name.endswith('mi foto.pdf')
    assert cur.inserts[0][3] == 'mi foto.pdf'


# --- imágenes (Pillow real, sin Office) ---

def test_image_jpg_to_pdf(tmp_path):
    src = tmp_path / 'foto.jpg'
    Image.new('RGB', (320, 200), (10, 60, 200)).save(src, 'JPEG')
    out = tmp_path / 'out.pdf'
    convert_image(src, out)
    pdf = pikepdf.open(out)
    assert len(pdf.pages) == 1


def test_image_transparent_png_composes_on_white(tmp_path):
    """La zona transparente debe salir BLANCA, no negra."""
    src = tmp_path / 'logo.png'
    Image.new('RGBA', (50, 50), (0, 0, 0, 0)).save(src)  # todo transparente
    out = tmp_path / 'out.pdf'
    convert_image(src, out)
    pdf = pikepdf.open(out)
    image = next(iter(pdf.pages[0].images.values()))
    pixels = pikepdf.PdfImage(image).as_pil_image().convert('RGB').getdata()
    assert pixels[0] == (255, 255, 255)


def test_image_invalid_rejected(tmp_path):
    src = tmp_path / 'roto.png'
    src.write_bytes(b'esto no es una imagen')
    with pytest.raises(ValueError, match='not a valid'):
        convert_image(src, tmp_path / 'out.pdf')


# --- integración COM (Office real; en dev corre, en CI se salta) ---

def _make_docx(path: Path, text: str, password: str = ''):
    """Genera un .docx con Word COM y CIERRA Word antes de volver.

    Importante: no dejar Word abierto durante la conversión — DispatchEx puede
    compartir la instancia existente (observado con Word 2016) y el test dejaría
    de reflejar el entorno real del worker (sin Office previo).
    """
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    app = win32com.client.DispatchEx('Word.Application')
    try:
        app.Visible = False
        app.DisplayAlerts = 0
        doc = app.Documents.Add()
        doc.Content.Text = text
        if password:
            # SaveAs2(FileName, FileFormat, LockComments, Password)
            doc.SaveAs2(str(path), 16, False, password)
        else:
            doc.SaveAs2(str(path), 16)
        doc.Close(False)
    finally:
        app.Quit()
        pythoncom.CoUninitialize()


@needs_word
def test_com_word_docx(tmp_path):
    src = tmp_path / 'doc.docx'
    _make_docx(src, 'Prueba de conversión con acentos: áéíóú ñ')
    out = tmp_path / 'out.pdf'
    office_com.convert_word(src, out)
    assert out.read_bytes()[:5] == b'%PDF-'
    assert len(pikepdf.open(out).pages) == 1


@needs_word
def test_com_word_password_fails_fast(tmp_path):
    src = tmp_path / 'protegido.docx'
    _make_docx(src, 'secreto', password='clave123')
    with pytest.raises(ValueError):
        office_com.convert_word(src, tmp_path / 'out.pdf')


@needs_word
def test_com_word_txt(tmp_path):
    src = tmp_path / 'notas.txt'
    src.write_text('línea uno\nlínea dos con ñ\n', encoding='utf-8')
    out = tmp_path / 'out.pdf'
    office_com.convert_word(src, out)
    assert out.read_bytes()[:5] == b'%PDF-'


@needs_excel
def test_com_excel_multisheet(tmp_path):
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    xl = win32com.client.DispatchEx('Excel.Application')
    xl.Visible = False
    xl.DisplayAlerts = False
    src = tmp_path / 'libro.xlsx'
    try:
        wb = xl.Workbooks.Add()
        wb.Sheets(1).Cells(1, 1).Value = 'Hoja uno'
        wb.Sheets.Add(None, wb.Sheets(wb.Sheets.Count))
        wb.Sheets(2).Cells(1, 1).Value = 'Hoja dos'
        wb.SaveAs(str(src), 51)
        wb.Close(False)
    finally:
        xl.Quit()
        pythoncom.CoUninitialize()

    out = tmp_path / 'out.pdf'
    office_com.convert_excel(src, out)
    # Un libro de dos hojas con contenido produce (al menos) dos páginas.
    assert len(pikepdf.open(out).pages) == 2


@needs_ppt
def test_com_powerpoint_pptx(tmp_path):
    import pythoncom
    import win32com.client
    pythoncom.CoInitialize()
    pp = win32com.client.DispatchEx('PowerPoint.Application')
    src = tmp_path / 'charla.pptx'
    try:
        pres = pp.Presentations.Add(0)
        pres.Slides.Add(1, 12)
        pres.SaveAs(str(src), 24)
        pres.Close()
    finally:
        pp.Quit()
        pythoncom.CoUninitialize()

    out = tmp_path / 'out.pdf'
    office_com.convert_powerpoint(src, out)
    assert out.read_bytes()[:5] == b'%PDF-'
