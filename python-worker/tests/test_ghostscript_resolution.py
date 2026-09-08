"""
Localización del ejecutable de Ghostscript.

Por qué existe este archivo: durante meses la compresión estuvo rota en el host
Windows de QA sin que nadie lo notara. El código daba por hecho que el binario
se llamaba `gs`, que es cierto en Unix pero NO en Windows (allí el ejecutable de
consola es `gswin64c`). El síntoma era un `[WinError 2] The system cannot find
the file specified` en el job, que no menciona a Ghostscript por ninguna parte.
"""
import subprocess
from pathlib import Path

import pytest

from app.compression import ghostscript as gsmod
from app.compression.ghostscript import GhostscriptCompressor, resolve_ghostscript


def test_windows_prefiere_gswin64c(monkeypatch):
    """En Windows el candidato principal es gswin64c, no gs."""
    monkeypatch.delenv('GHOSTSCRIPT_PATH', raising=False)
    monkeypatch.setattr(gsmod, '_CANDIDATOS', ('gswin64c', 'gswin32c', 'gs'))
    monkeypatch.setattr(
        gsmod.shutil, 'which',
        lambda n: r'C:\gs\bin\gswin64c.exe' if n == 'gswin64c' else None,
    )
    assert resolve_ghostscript() == r'C:\gs\bin\gswin64c.exe'


def test_cae_a_gs_si_no_hay_binario_de_windows(monkeypatch):
    """Con solo `gs` disponible (Unix, o el alias de QA) se usa ese."""
    monkeypatch.delenv('GHOSTSCRIPT_PATH', raising=False)
    monkeypatch.setattr(gsmod, '_CANDIDATOS', ('gswin64c', 'gswin32c', 'gs'))
    monkeypatch.setattr(
        gsmod.shutil, 'which',
        lambda n: '/usr/bin/gs' if n == 'gs' else None,
    )
    assert resolve_ghostscript() == '/usr/bin/gs'


def test_ghostscript_path_manda_sobre_el_descubrimiento(monkeypatch, tmp_path):
    """Una instalación fuera del PATH se declara con GHOSTSCRIPT_PATH."""
    fake = tmp_path / 'gswin64c.exe'
    fake.write_bytes(b'x')
    monkeypatch.setenv('GHOSTSCRIPT_PATH', str(fake))
    monkeypatch.setattr(gsmod.shutil, 'which', lambda n: '/otro/gs')
    assert resolve_ghostscript() == str(fake)


def test_ghostscript_path_admite_un_nombre_a_resolver(monkeypatch):
    """Si GHOSTSCRIPT_PATH no es un fichero, se resuelve por PATH."""
    monkeypatch.setenv('GHOSTSCRIPT_PATH', 'mi-gs')
    monkeypatch.setattr(gsmod.shutil, 'which', lambda n: '/bin/mi-gs' if n == 'mi-gs' else None)
    assert resolve_ghostscript() == '/bin/mi-gs'


def test_sin_ghostscript_devuelve_el_primer_candidato(monkeypatch):
    """Para que el mensaje de error diga qué nombre se buscó."""
    monkeypatch.delenv('GHOSTSCRIPT_PATH', raising=False)
    monkeypatch.setattr(gsmod, '_CANDIDATOS', ('gswin64c', 'gs'))
    monkeypatch.setattr(gsmod.shutil, 'which', lambda n: None)
    assert resolve_ghostscript() == 'gswin64c'


def test_error_util_cuando_ghostscript_no_esta(monkeypatch, tmp_path):
    """
    El fallo debe explicar QUÉ falta. El `[WinError 2]` crudo es lo que hizo que
    la avería pasara desapercibida en QA.
    """
    def boom(*a, **k):
        raise FileNotFoundError(2, 'The system cannot find the file specified')

    monkeypatch.setattr(subprocess, 'run', boom)
    compresor = GhostscriptCompressor(gs_path='gswin64c')

    with pytest.raises(Exception) as exc:
        compresor.compress(tmp_path / 'in.pdf', tmp_path / 'out.pdf')

    mensaje = str(exc.value)
    assert 'Ghostscript' in mensaje
    assert 'gswin64c' in mensaje
    assert 'GHOSTSCRIPT_PATH' in mensaje


def test_el_compresor_resuelve_solo_si_no_le_dan_ruta(monkeypatch):
    monkeypatch.delenv('GHOSTSCRIPT_PATH', raising=False)
    monkeypatch.setattr(gsmod, '_CANDIDATOS', ('gswin64c',))
    monkeypatch.setattr(gsmod.shutil, 'which', lambda n: r'C:\gs\gswin64c.exe')
    assert GhostscriptCompressor().gs_path == r'C:\gs\gswin64c.exe'
    assert GhostscriptCompressor(gs_path='/ruta/explicita/gs').gs_path == '/ruta/explicita/gs'
