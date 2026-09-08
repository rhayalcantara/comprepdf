"""Selector del motor Office → PDF de la operación `convert`.

Dos motores con el mismo contrato (`convert_word/excel/powerpoint(input, output)`):
  - `office_com`   — Microsoft Office vía COM. Solo Windows (QA nativo).
  - `office_libre` — LibreOffice headless. Linux/contenedor (producción).

Se elige en el arranque: COM si pywin32 está disponible (Windows), si no
LibreOffice si `soffice` está en el PATH (o `LIBREOFFICE_PATH`). Sin ninguno,
las tres funciones fallan con un ValueError claro que llega a `error_message`
del job, y el resto del worker sigue funcionando. `OFFICE_ENGINE=com|libreoffice`
fuerza uno (útil para probar LibreOffice en un Windows con Office).
"""
import os

from app.converters import office_com, office_libre


def select_engine() -> str:
    forced = (os.getenv('OFFICE_ENGINE') or '').strip().lower()
    if forced in ('com', 'libreoffice'):
        return forced
    if office_com.COM_AVAILABLE:
        return 'com'
    if office_libre.find_soffice():
        return 'libreoffice'
    return 'none'


ENGINE = select_engine()

if ENGINE == 'com':
    from app.converters.office_com import convert_excel, convert_powerpoint, convert_word
else:
    # 'libreoffice' o 'none': office_libre ya devuelve el error "not available"
    # cuando no encuentra soffice.
    from app.converters.office_libre import convert_excel, convert_powerpoint, convert_word

__all__ = ['ENGINE', 'select_engine', 'convert_word', 'convert_excel', 'convert_powerpoint']
