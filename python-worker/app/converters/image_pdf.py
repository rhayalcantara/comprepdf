"""Conversión de imágenes (JPG/PNG) a PDF con Pillow — sin Office.

Misma higiene que la imagen de la firma (sign.py): solo los píxeles
DECODIFICADOS llegan al PDF, nunca los bytes originales del usuario, lo que
descarta cualquier payload incrustado. La protección anti decompression-bomb
de Pillow (Image.MAX_IMAGE_PIXELS) queda activa con su valor por defecto.
"""
from pathlib import Path

from PIL import Image, UnidentifiedImageError

# Resolución declarada en el PDF: 150 dpi deja una imagen de cámara normal en
# un tamaño de página razonable sin re-muestrear los píxeles.
PDF_RESOLUTION_DPI = 150.0


def convert_image(input_path: Path, output_path: Path) -> None:
    """Convierte una imagen a un PDF de una página del tamaño de la imagen."""
    try:
        with Image.open(input_path) as raw:
            raw.load()
            image = _flatten(raw)
    except Image.DecompressionBombError:
        raise ValueError('Image has too many pixels')
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ValueError('File is not a valid JPG/PNG image')

    image.save(output_path, 'PDF', resolution=PDF_RESOLUTION_DPI)


def _flatten(raw: Image.Image) -> Image.Image:
    """A RGB, componiendo la transparencia sobre blanco.

    PDF no lleva canal alfa: un convert('RGB') directo pintaría de NEGRO las
    zonas transparentes de un PNG; se compone sobre fondo blanco.
    """
    if raw.mode in ('RGBA', 'LA', 'P'):
        rgba = raw.convert('RGBA')
        background = Image.new('RGB', rgba.size, (255, 255, 255))
        background.paste(rgba, mask=rgba.getchannel('A'))
        return background
    return raw.convert('RGB')
