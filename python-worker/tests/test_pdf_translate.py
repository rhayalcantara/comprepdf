"""Tests de la operación translate (PDF traducido con LLM local vía Ollama).

El LLM se simula (mock de `_translate_batch` o de `requests.post`): aquí se
valida la mecánica PyMuPDF (bloques, redacción, reinserción), el contrato de
errores y el handler. Los PDFs de prueba se generan con reportlab/pikepdf.
"""
from pathlib import Path
from unittest.mock import patch

import fitz
import pikepdf
import pytest
import requests
from reportlab.pdfgen import canvas as rl_canvas

from app.config import settings
import app.converters.pdf_translate as pdf_translate
from app.converters.pdf_translate import translate_pdf
from app.operations.pdf_translate import handle_translate


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
    c = rl_canvas.Canvas(str(path), pagesize=(612, 792))
    c.rect(100, 100, 400, 500, fill=1)
    c.showPage()
    c.save()


def _pdf_text(path: Path) -> str:
    doc = fitz.open(str(path))
    try:
        return '\n'.join(page.get_text() for page in doc)
    finally:
        doc.close()


def _fake_batch(segments, language):
    return [f'[{language}] {s}' for s in segments]


# --- conversor ---

def test_translate_replaces_text_in_place(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Solicitud de credito', 'Complete todos los campos'])
    out = tmp_path / 'out.pdf'
    with patch.object(pdf_translate, '_translate_batch', side_effect=_fake_batch):
        translate_pdf(src, out, 'en')

    text = _pdf_text(out)
    assert '[English] Solicitud de credito' in text
    # El original desapareció de verdad (redacción, no texto encima).
    assert '\nSolicitud de credito' not in text
    assert text.count('[English]') == 2


def test_translate_multipage(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Contenido de la pagina'], pages=3)
    out = tmp_path / 'out.pdf'
    with patch.object(pdf_translate, '_translate_batch', side_effect=_fake_batch):
        translate_pdf(src, out, 'fr')
    assert _pdf_text(out).count('[French]') == 3


def test_longer_translation_still_fits(tmp_path):
    """Traducción mucho más larga que el original: reduce la fuente, no la pierde."""
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Si'])
    out = tmp_path / 'out.pdf'

    def inflate(segments, language):
        return ['Yes, absolutely confirmed' for _ in segments]

    with patch.object(pdf_translate, '_translate_batch', side_effect=inflate):
        translate_pdf(src, out, 'en')
    assert 'Yes, absolutely confirmed' in _pdf_text(out).replace('\n', ' ')


def test_unsupported_language_rejected(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Hola'])
    with pytest.raises(ValueError, match='Unsupported target language'):
        translate_pdf(src, tmp_path / 'out.pdf', 'zh')


def test_scanned_pdf_rejected(tmp_path):
    src = tmp_path / 'escaneado.pdf'
    make_imageonly_pdf(src)
    with pytest.raises(ValueError, match='scanned'):
        translate_pdf(src, tmp_path / 'out.pdf', 'en')


def test_encrypted_pdf_rejected(tmp_path):
    plain = tmp_path / 'plain.pdf'
    make_text_pdf(plain, ['secreto'])
    src = tmp_path / 'cifrado.pdf'
    with pikepdf.open(plain) as pdf:
        pdf.save(src, encryption=pikepdf.Encryption(user='clave', owner='clave', R=6))
    with pytest.raises(ValueError, match='password-protected'):
        translate_pdf(src, tmp_path / 'out.pdf', 'en')


def test_ollama_down_gives_clear_error(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Hola'])
    with patch.object(pdf_translate.requests, 'post',
                      side_effect=requests.ConnectionError('refused')):
        with pytest.raises(ValueError, match='translation server is not available'):
            translate_pdf(src, tmp_path / 'out.pdf', 'en')


def test_misaligned_llm_output_fails_after_retry(tmp_path):
    """El LLM devuelve un número distinto de traducciones: reintenta y falla claro."""
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Hola'])
    with patch.object(pdf_translate, '_chat', return_value=[]) as chat:
        with pytest.raises(ValueError, match='inconsistent result'):
            translate_pdf(src, tmp_path / 'out.pdf', 'en')
    assert chat.call_count == 2  # intento + un reintento


# --- handler ---

def test_handler_registers_pdf_with_lang_suffix(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Contenido'])
    cur = FakeCursor([_original(src, 'contrato.pdf')])
    with patch.object(pdf_translate, '_translate_batch', side_effect=_fake_batch):
        result = handle_translate(
            {'id': 'j1', 'operation_params': {'target_lang': 'en'}}, cur)

    assert result['files_output'] == 1
    assert cur.inserts[0][3] == 'contrato_en.pdf'
    assert cur.inserts[0][6] == 'application/pdf'


def test_handler_respects_custom_name_without_suffix(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Contenido'])
    cur = FakeCursor([_original(src)])
    with patch.object(pdf_translate, '_translate_batch', side_effect=_fake_batch):
        handle_translate(
            {'id': 'j1', 'operation_params': {'target_lang': 'de', 'output_name': 'informe'}}, cur)
    assert cur.inserts[0][3] == 'informe.pdf'


def test_handler_rejects_missing_language(tmp_path):
    src = tmp_path / 'in.pdf'
    make_text_pdf(src, ['Contenido'])
    cur = FakeCursor([_original(src)])
    with pytest.raises(ValueError, match='Unsupported target language'):
        handle_translate({'id': 'j1', 'operation_params': {}}, cur)
