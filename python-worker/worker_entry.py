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
"""
from app.workers.poller import main

if __name__ == '__main__':
    main()
