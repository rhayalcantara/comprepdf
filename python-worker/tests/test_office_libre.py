"""Tests del motor LibreOffice headless (`office_libre`) y del selector de motor.

No requieren LibreOffice: se simula `soffice` con un script Python que
reproduce su contrato (escribe `<stem>.pdf` en `--outdir`) apuntando a él con
`LIBREOFFICE_PATH`. Si hay un LibreOffice real en el host, además se hace una
conversión de verdad (integración).
"""
import os
import shutil
import stat
import sys
import textwrap
from pathlib import Path

import pytest

from app.converters import office, office_libre


def _fake_soffice(tmp_path: Path, behaviour: str) -> Path:
    """Crea un ejecutable que imita a soffice. `behaviour`: ok | empty | silent | hang | stderr."""
    script = tmp_path / 'fake_soffice.py'
    script.write_text(textwrap.dedent(f'''
        import sys, time
        from pathlib import Path
        args = sys.argv[1:]
        outdir = Path(args[args.index('--outdir') + 1])
        src = Path(args[-1])
        behaviour = {behaviour!r}
        if behaviour == 'hang':
            time.sleep(30)
        if behaviour == 'ok':
            (outdir / (src.stem + '.pdf')).write_bytes(b'%PDF-1.4\\n%fake\\n')
        elif behaviour == 'empty':
            (outdir / (src.stem + '.pdf')).write_bytes(b'')
        elif behaviour == 'stderr':
            sys.stderr.write('Error: source file could not be loaded\\n'); sys.exit(1)
        # 'silent': no output, exit 0 (lo que hace LibreOffice con un doc cifrado)
    '''))
    if os.name == 'nt':
        launcher = tmp_path / 'soffice.cmd'
        launcher.write_text(f'@"{sys.executable}" "{script}" %*\n')
    else:
        launcher = tmp_path / 'soffice'
        launcher.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{script}" "$@"\n')
        launcher.chmod(launcher.stat().st_mode | stat.S_IEXEC)
    return launcher


@pytest.fixture
def doc(tmp_path):
    src = tmp_path / 'informe anual.docx'
    src.write_bytes(b'PK\x03\x04fake')
    return src


def _use(monkeypatch, launcher: Path):
    monkeypatch.setenv('LIBREOFFICE_PATH', str(launcher))


def test_find_soffice_prefers_env(monkeypatch, tmp_path):
    launcher = _fake_soffice(tmp_path, 'ok')
    _use(monkeypatch, launcher)
    assert office_libre.find_soffice() == str(launcher)
    monkeypatch.setenv('LIBREOFFICE_PATH', str(tmp_path / 'nope'))
    assert office_libre.find_soffice() is None


def test_missing_soffice_is_clear_error(monkeypatch, tmp_path, doc):
    monkeypatch.setenv('LIBREOFFICE_PATH', str(tmp_path / 'nope'))
    with pytest.raises(ValueError, match='LibreOffice missing'):
        office_libre.convert_word(doc, tmp_path / 'out.pdf')


def test_ok_moves_pdf_to_requested_path(monkeypatch, tmp_path, doc):
    _use(monkeypatch, _fake_soffice(tmp_path, 'ok'))
    out = tmp_path / 'salida' / 'resultado.pdf'
    office_libre.convert_word(doc, out)
    assert out.read_bytes().startswith(b'%PDF-')
    # el outdir temporal se limpió: no quedan restos junto al original
    assert not (tmp_path / 'informe anual.pdf').exists()


@pytest.mark.parametrize('fn', [office_libre.convert_excel, office_libre.convert_powerpoint])
def test_other_families_share_the_engine(monkeypatch, tmp_path, doc, fn):
    _use(monkeypatch, _fake_soffice(tmp_path, 'ok'))
    out = tmp_path / 'o.pdf'
    fn(doc, out)
    assert out.exists()


def test_silent_no_output_reports_protected_or_corrupt(monkeypatch, tmp_path, doc):
    _use(monkeypatch, _fake_soffice(tmp_path, 'silent'))
    with pytest.raises(ValueError, match='password-protected or corrupt'):
        office_libre.convert_word(doc, tmp_path / 'o.pdf')


def test_empty_output_rejected(monkeypatch, tmp_path, doc):
    _use(monkeypatch, _fake_soffice(tmp_path, 'empty'))
    with pytest.raises(ValueError, match='could not convert'):
        office_libre.convert_word(doc, tmp_path / 'o.pdf')


def test_stderr_detail_reaches_message(monkeypatch, tmp_path, doc):
    _use(monkeypatch, _fake_soffice(tmp_path, 'stderr'))
    with pytest.raises(ValueError, match='could not be loaded'):
        office_libre.convert_word(doc, tmp_path / 'o.pdf')


def test_timeout_kills_and_reports(monkeypatch, tmp_path, doc):
    _use(monkeypatch, _fake_soffice(tmp_path, 'hang'))
    monkeypatch.setattr(office_libre, 'CONVERT_TIMEOUT_S', 2)
    with pytest.raises(ValueError, match='timed out'):
        office_libre.convert_word(doc, tmp_path / 'o.pdf')


def test_missing_input(monkeypatch, tmp_path):
    _use(monkeypatch, _fake_soffice(tmp_path, 'ok'))
    with pytest.raises(ValueError, match='not found'):
        office_libre.convert_word(tmp_path / 'no.docx', tmp_path / 'o.pdf')


# --- selector de motor ---

def test_engine_forced_by_env(monkeypatch):
    monkeypatch.setenv('OFFICE_ENGINE', 'libreoffice')
    assert office.select_engine() == 'libreoffice'
    monkeypatch.setenv('OFFICE_ENGINE', 'com')
    assert office.select_engine() == 'com'


def test_engine_autodetect(monkeypatch, tmp_path):
    monkeypatch.delenv('OFFICE_ENGINE', raising=False)
    monkeypatch.setattr(office.office_com, 'COM_AVAILABLE', False)
    monkeypatch.setenv('LIBREOFFICE_PATH', str(tmp_path / 'nope'))
    assert office.select_engine() == 'none'
    _use(monkeypatch, _fake_soffice(tmp_path, 'ok'))
    assert office.select_engine() == 'libreoffice'
    monkeypatch.setattr(office.office_com, 'COM_AVAILABLE', True)
    assert office.select_engine() == 'com'


# --- integración con un LibreOffice real, si lo hay ---

@pytest.mark.skipif(not shutil.which('soffice'), reason='LibreOffice no instalado')
def test_real_libreoffice_docx(tmp_path, monkeypatch):
    monkeypatch.delenv('LIBREOFFICE_PATH', raising=False)
    from docx import Document  # python-docx llega con pdf2docx
    src = tmp_path / 'real.docx'
    d = Document(); d.add_paragraph('Hola LibreOffice'); d.save(src)
    out = tmp_path / 'real.pdf'
    office_libre.convert_word(src, out)
    assert out.read_bytes().startswith(b'%PDF-')
