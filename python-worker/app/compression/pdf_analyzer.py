from pathlib import Path
from typing import Dict, Optional
import pikepdf


class PdfAnalyzer:
    """Analiza información de archivos PDF."""

    def analyze(self, pdf_path: Path) -> Dict:
        """
        Analiza un archivo PDF y retorna información sobre su contenido.

        Args:
            pdf_path: Ruta al archivo PDF

        Returns:
            Diccionario con información del PDF
        """
        try:
            with pikepdf.open(pdf_path) as pdf:
                info = {
                    'pages_count': len(pdf.pages),
                    'images_count': self._count_images(pdf),
                    'file_size': pdf_path.stat().st_size,
                    'is_encrypted': False,
                    'pdf_version': str(pdf.pdf_version),
                    'metadata': self._extract_metadata(pdf),
                }
                return info
        except pikepdf.PasswordError:
            return {
                'pages_count': 0,
                'images_count': 0,
                'file_size': pdf_path.stat().st_size,
                'is_encrypted': True,
                'pdf_version': None,
                'metadata': {},
            }
        except Exception as e:
            raise Exception(f"Error analyzing PDF: {str(e)}")

    def _count_images(self, pdf: pikepdf.Pdf) -> int:
        """Cuenta el número de imágenes en el PDF."""
        image_count = 0
        for page in pdf.pages:
            try:
                if '/Resources' in page and '/XObject' in page['/Resources']:
                    xobjects = page['/Resources']['/XObject']
                    for obj in xobjects:
                        try:
                            xobject = xobjects[obj]
                            if xobject.get('/Subtype') == '/Image':
                                image_count += 1
                        except:
                            continue
            except:
                continue
        return image_count

    def _extract_metadata(self, pdf: pikepdf.Pdf) -> Dict:
        """Extrae metadata del PDF."""
        metadata = {}
        try:
            if pdf.docinfo:
                for key, value in pdf.docinfo.items():
                    try:
                        metadata[str(key)] = str(value)
                    except:
                        continue
        except:
            pass
        return metadata

    def validate_pdf(self, pdf_path: Path) -> bool:
        """
        Valida si el archivo es un PDF válido.

        Args:
            pdf_path: Ruta al archivo PDF

        Returns:
            True si es válido, False en caso contrario
        """
        try:
            with pikepdf.open(pdf_path) as pdf:
                # Intentar leer al menos una página
                if len(pdf.pages) > 0:
                    return True
            return False
        except:
            return False
