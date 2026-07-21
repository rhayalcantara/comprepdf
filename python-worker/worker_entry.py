"""Punto de entrada para el build PyInstaller del worker (comprepdf-worker.exe).

Build (onedir, desde python-worker/). IMPRESCINDIBLE incluir las DLLs vendor de
mysql-connector: la extensión C carga mysql_native_password.dll en runtime y
PyInstaller no la detecta (sin ella el worker conecta y muere en bucle, sin log):

    $vendor = "<site-packages>\\mysql\\vendor"
    python -m PyInstaller --noconfirm --name comprepdf-worker `
        --collect-submodules mysql.connector `
        --add-binary "$vendor\\plugin\\*.dll;mysql\\vendor\\plugin" `
        --add-binary "$vendor\\*.dll;mysql\\vendor" `
        worker_entry.py

El resultado queda en dist/comprepdf-worker/ y se despliega tal cual a QA
(C:\\comprepdf\\worker\\comprepdf-worker; swap con update-backend-worker.bat).
Config por variables de entorno (ver app/config.py); start.bat de QA define
OUTPUT_DIR.

Modo CLI (sin MySQL): `comprepdf-worker.exe --convert entrada salida.pdf`
convierte UN archivo con el mismo motor de la operación `convert`. Sirve como
smoke del exe congelado (¿funciona pywin32/COM dentro del bundle?) y es la
semilla del futuro modo batch de carpeta vigilada.
"""
import sys


def _cli_convert(argv: list) -> int:
    """Convierte un archivo a PDF por línea de comandos. Devuelve exit code."""
    if len(argv) != 2:
        print('uso: comprepdf-worker --convert <entrada> <salida.pdf>')
        return 2
    from pathlib import Path

    from app.converters.image_pdf import convert_image
    from app.converters.office_com import convert_excel, convert_powerpoint, convert_word
    from app.operations.convert import EXCEL_EXTS, IMAGE_EXTS, PPT_EXTS, WORD_EXTS

    src, dst = Path(argv[0]), Path(argv[1])
    ext = src.suffix.lower()
    try:
        if ext in IMAGE_EXTS:
            convert_image(src, dst)
        elif ext in WORD_EXTS:
            convert_word(src, dst)
        elif ext in EXCEL_EXTS:
            convert_excel(src, dst)
        elif ext in PPT_EXTS:
            convert_powerpoint(src, dst)
        else:
            print(f'extension no soportada: {ext}')
            return 2
    except ValueError as exc:
        print(f'ERROR: {exc}')
        return 1
    print(f'OK: {dst} ({dst.stat().st_size} bytes)')
    return 0


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--convert':
        sys.exit(_cli_convert(sys.argv[2:]))
    from app.workers.poller import main
    main()
