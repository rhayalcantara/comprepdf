"""Tests de la operación pdf_to_word (PDF → docx con pdf2docx).

No necesita Office: pdf2docx es Python puro (PyMuPDF). Los PDFs de prueba se
generan con reportlab (texto real) y pikepdf (cifrado).
"""
import io
from pathlib import Path

import pikepdf
import pytest
from docx import Document
from reportlab.pdfgen import canvas as rl_canvas

from app.config import settings
from app.converters.pdf_word import convert_pdf_to_word
from app.operations.pdf_to_word import handle_pdf_to_word


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


def _original(path: Path, name: str = 'doc.pdf'):
    return {'id': 'f1', 'file_path': str(path), 'original_filename': name,
            'filename': path.name}


def make_text_pdf(path: Path, lines, pages: int = 1) -> None:
    """PDF con texto REAL extraíble (reportlab)."""
    c = rl_canvas.Canvas(str(path), pagesize=(612, 792))
    for _ in range(pages):
        y = 700
        for line in lines:
            c.setFont('Helvetica', 12)
            c.drawString(72, y, line)
            y -= 20
        c.showPage()
    c.save()


def make_imageonly_pdf(path: Path) -> None:
    """PDF "escaneado": una página con un rectángulo dibujado y CERO texto."""
    c = rl_canvas.Canvas(str(path), pagesize=(612, 792))
    c.rect(100, 100, 400, 500, fill=1)
    c.showPage()
    c.save()


def _docx_text(path: Path) -> str:
    return '\n'.join(p.text for p in Document(str(path)).paragraphs)


# --- conversor ---

def test_pdf_to_word_recovers_text(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Informe de conversión', 'Acentos: áéíóú ñ'])
    out = tmp_path / 'out.docx'
    convert_pdf_to_word(src, out)

    text = _docx_text(out)
    assert 'Informe de conversión' in text
    assert 'áéíóú ñ' in text


def test_pdf_to_word_multipage(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Página con contenido'], pages=3)
    out = tmp_path / 'out.docx'
    convert_pdf_to_word(src, out)
    assert out.stat().st_size > 0
    assert out.read_bytes()[:2] == b'PK'


def test_scanned_pdf_rejected_with_clear_message(tmp_path):
    src = tmp_path / 'escaneado.pdf'
    make_imageonly_pdf(src)
    with pytest.raises(ValueError, match='scanned'):
        convert_pdf_to_word(src, tmp_path / 'out.docx')


def test_encrypted_pdf_rejected(tmp_path):
    plain = tmp_path / 'plain.pdf'
    make_text_pdf(plain, ['secreto'])
    src = tmp_path / 'cifrado.pdf'
    with pikepdf.open(plain) as pdf:
        pdf.save(src, encryption=pikepdf.Encryption(user='clave', owner='clave', R=6))
    with pytest.raises(ValueError, match='password-protected'):
        convert_pdf_to_word(src, tmp_path / 'out.docx')


def test_not_a_pdf_rejected(tmp_path):
    src = tmp_path / 'falso.pdf'
    src.write_bytes(b'no soy un pdf')
    with pytest.raises(ValueError, match='not a valid PDF'):
        convert_pdf_to_word(src, tmp_path / 'out.docx')


# --- handler ---

def test_handler_registers_docx_output(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Contenido'])
    cur = FakeCursor([_original(src, 'contrato.pdf')])
    result = handle_pdf_to_word({'id': 'j1', 'operation_params': {}}, cur)

    assert result['files_output'] == 1
    out = cur.output_paths()[0]
    assert out.name.endswith('contrato.docx')
    # register_output inserta (…, download_name, path, size, mime)
    assert cur.inserts[0][3] == 'contrato.docx'
    assert 'wordprocessingml' in cur.inserts[0][6]


def test_handler_custom_name_strips_docx_suffix(tmp_path):
    """"informe.docx" como nombre elegido no debe producir informe.docx.docx."""
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Contenido'])
    cur = FakeCursor([_original(src)])
    handle_pdf_to_word({'id': 'j1', 'operation_params': {'output_name': 'informe.docx'}}, cur)
    assert cur.inserts[0][3] == 'informe.docx'
