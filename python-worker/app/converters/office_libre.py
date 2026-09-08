"""Conversión de documentos Office a PDF con LibreOffice headless (Linux/contenedor).

Es el motor de `convert` cuando no hay COM de Microsoft Office (producción
corre en Ubuntu dentro de Docker). Mismo contrato que `office_com`: una
función por familia que recibe entrada y salida y lanza `ValueError` con un
mensaje apto para `error_message` del job.

Robustez:
  - `soffice --headless --convert-to pdf --outdir <tmp>`: LibreOffice escribe
    `<stem>.pdf` en outdir; se mueve a la ruta pedida. Se usa un outdir
    temporal propio para que dos jobs con el mismo nombre no se pisen.
  - Perfil de usuario propio y efímero (`-env:UserInstallation`): sin él, dos
    instancias simultáneas se bloquean entre sí y un perfil corrupto deja
    TODAS las conversiones colgadas. Además arranca sin recovery ni diálogos.
  - Timeout: un documento patológico no puede parar el poller (secuencial).
    `subprocess.run(timeout=)` mata soffice y se reporta como timeout.
  - Macros: en headless LibreOffice NO ejecuta macros por defecto; no hay nada
    que forzar.
  - Documentos protegidos con contraseña: headless no puede pedirla; soffice
    termina sin producir salida (o con código != 0) → error claro.
"""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

CONVERT_TIMEOUT_S = 180

_SOFFICE_CANDIDATES = ('soffice', 'libreoffice', 'soffice.bin')


def find_soffice() -> Optional[str]:
    """Ruta al ejecutable de LibreOffice, o None si no está instalado.

    `LIBREOFFICE_PATH` manda si está definida (mismo patrón que
    `GHOSTSCRIPT_PATH`).
    """
    fixed = os.getenv('LIBREOFFICE_PATH')
    if fixed:
        return fixed if Path(fixed).exists() else None
    for name in _SOFFICE_CANDIDATES:
        found = shutil.which(name)
        if found:
            return found
    return None


LIBREOFFICE_AVAILABLE = find_soffice() is not None


def _convert(input_path: Path, output_path: Path, app_name: str,
             export_filter: str) -> None:
    soffice = find_soffice()
    if not soffice:
        raise ValueError('Office conversion is not available on this host (LibreOffice missing)')
    if not input_path.exists():
        raise ValueError('Input document not found')

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='lo-') as tmp:
        tmp_path = Path(tmp)
        profile = tmp_path / 'profile'
        outdir = tmp_path / 'out'
        outdir.mkdir()
        cmd = [
            soffice,
            f'-env:UserInstallation={profile.as_uri()}',
            '--headless', '--norestore', '--nolockcheck', '--nodefault',
            '--convert-to', export_filter,
            '--outdir', str(outdir),
            str(input_path),
        ]
        try:
            proc = subprocess.run(
                cmd, capture_output=True, text=True, timeout=CONVERT_TIMEOUT_S,
                env={**os.environ, 'HOME': str(tmp_path)},
            )
        except subprocess.TimeoutExpired:
            raise ValueError(f'{app_name} conversion timed out after {CONVERT_TIMEOUT_S}s')
        except OSError as exc:
            raise ValueError(f'{app_name} could not start LibreOffice: {exc}')

        produced = outdir / f'{input_path.stem}.pdf'
        if proc.returncode != 0 or not produced.exists() or produced.stat().st_size == 0:
            raise ValueError(_error_message(app_name, proc))
        shutil.move(str(produced), str(output_path))


def _error_message(app_name: str, proc: 'subprocess.CompletedProcess[str]') -> str:
    detail = (proc.stderr or proc.stdout or '').strip()
    low = detail.lower()
    if 'password' in low or 'contraseña' in low or 'encrypted' in low:
        return 'The document is password-protected'
    if not detail:
        # LibreOffice calla ante un documento cifrado o ilegible: sin salida y
        # sin mensaje. Es el caso más frecuente del "no produjo nada".
        return f'{app_name} could not convert the document (no output; is it password-protected or corrupt?)'
    return f'{app_name} could not convert the document: {detail[:300]}'


def convert_word(input_path: Path, output_path: Path) -> None:
    """DOC/DOCX/RTF/ODT/TXT → PDF (Writer)."""
    _convert(input_path, output_path, 'Word', 'pdf:writer_pdf_Export')


def convert_excel(input_path: Path, output_path: Path) -> None:
    """XLS/XLSX/ODS → PDF (Calc; todas las hojas)."""
    _convert(input_path, output_path, 'Excel', 'pdf:calc_pdf_Export')


def convert_powerpoint(input_path: Path, output_path: Path) -> None:
    """PPT/PPTX/ODP → PDF (Impress)."""
    _convert(input_path, output_path, 'PowerPoint', 'pdf:impress_pdf_Export')
