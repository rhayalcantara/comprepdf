import subprocess
from pathlib import Path
from typing import Literal, Dict, Optional

CompressionLevel = Literal['low', 'medium', 'high', 'custom']

COMPRESSION_SETTINGS = {
    'low': '/screen',      # 72 DPI
    'medium': '/ebook',    # 150 DPI
    'high': '/printer',    # 300 DPI
}

class GhostscriptCompressor:
    def __init__(self, gs_path: str = 'gs'):
        self.gs_path = gs_path

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

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300  # 5 minutos máximo
        )

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
