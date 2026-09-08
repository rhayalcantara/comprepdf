import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Literal, Dict, Optional

CompressionLevel = Literal['low', 'medium', 'high', 'custom']

COMPRESSION_SETTINGS = {
    'low': '/screen',      # 72 DPI
    'medium': '/ebook',    # 150 DPI
    'high': '/printer',    # 300 DPI
}

# Nombres del ejecutable de consola de Ghostscript, en orden de preferencia.
# En Windows NO existe `gs`: el binario de consola es `gswin64c` (o `gswin32c`).
# Dar por hecho `gs` es lo que tuvo la compresión rota en el host Windows de QA
# sin que nadie lo notara — fallaba con "[WinError 2] The system cannot find the
# file specified", que no dice nada sobre Ghostscript.
_CANDIDATOS = ('gswin64c', 'gswin32c', 'gs') if sys.platform == 'win32' else ('gs',)


def resolve_ghostscript() -> str:
    """
    Localiza el ejecutable de Ghostscript.

    Orden: la variable GHOSTSCRIPT_PATH (para instalaciones fuera del PATH),
    luego los nombres habituales según el sistema. Si no aparece ninguno se
    devuelve el primer candidato para que el error de `subprocess` mencione el
    nombre que se buscó.
    """
    configurado = os.getenv('GHOSTSCRIPT_PATH', '').strip()
    if configurado:
        # Puede ser una ruta completa al .exe o un nombre a resolver por PATH.
        return configurado if Path(configurado).is_file() else (shutil.which(configurado) or configurado)

    for nombre in _CANDIDATOS:
        encontrado = shutil.which(nombre)
        if encontrado:
            return encontrado

    return _CANDIDATOS[0]


class GhostscriptCompressor:
    def __init__(self, gs_path: Optional[str] = None):
        self.gs_path = gs_path or resolve_ghostscript()

    def compress(
        self,
        input_path: Path,
        output_path: Path,
        level: CompressionLevel = 'medium',
        custom_dpi: Optional[int] = None
    ) -> Dict:
        """Comprime un PDF usando Ghostscript."""

        if level == 'custom' and custom_dpi:
            cmd = self._build_custom_command(input_path, output_path, custom_dpi)
        else:
            cmd = self._build_preset_command(input_path, output_path, level)

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=300  # 5 minutos máximo
            )
        except FileNotFoundError as exc:
            # El error crudo ("[WinError 2] The system cannot find the file
            # specified") no dice QUE falta; el usuario ve eso en el job.
            raise Exception(
                f"Ghostscript no está instalado o no se encuentra en el PATH "
                f"(se buscó '{self.gs_path}'). Instálalo en el host del worker o "
                f"define GHOSTSCRIPT_PATH con la ruta al ejecutable."
            ) from exc

        if result.returncode != 0:
            raise Exception(f"Ghostscript error: {result.stderr}")

        return {
            'original_size': input_path.stat().st_size,
            'compressed_size': output_path.stat().st_size,
        }

    def _build_preset_command(self, input_path: Path, output_path: Path, level: str) -> list:
        return [
            self.gs_path,
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.4',
            f'-dPDFSETTINGS={COMPRESSION_SETTINGS.get(level, "/ebook")}',
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            '-dSAFER',
            f'-sOutputFile={output_path}',
            str(input_path)
        ]

    def _build_custom_command(self, input_path: Path, output_path: Path, dpi: int) -> list:
        return [
            self.gs_path,
            '-sDEVICE=pdfwrite',
            '-dCompatibilityLevel=1.4',
            '-dDownsampleColorImages=true',
            f'-dColorImageResolution={dpi}',
            '-dDownsampleGrayImages=true',
            f'-dGrayImageResolution={dpi}',
            '-dDownsampleMonoImages=true',
            f'-dMonoImageResolution={dpi}',
            '-dNOPAUSE',
            '-dQUIET',
            '-dBATCH',
            '-dSAFER',
            f'-sOutputFile={output_path}',
            str(input_path)
        ]
