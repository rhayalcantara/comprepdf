# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all, collect_dynamic_libs, collect_submodules

hiddenimports = []
hiddenimports += collect_submodules('mysql.connector')
hiddenimports += collect_submodules('PIL')
# pywin32 (COM de Office para la operación convert). El dispatch es dinámico
# (sin gen_py), así que basta con los módulos base de win32com.
hiddenimports += ['pythoncom', 'win32com', 'win32com.client', 'win32com.client.dynamic',
                  'win32api', 'win32con', 'win32process']
# pdf2docx (operación pdf_to_word): collect_all por sus plantillas/datos, y sus
# dependencias pesadas (PyMuPDF/fitz, opencv, numpy) van por hooks de PyInstaller.
_p2d_datas, _p2d_binaries, _p2d_hiddenimports = collect_all('pdf2docx')
hiddenimports += _p2d_hiddenimports

# Pillow trae extensiones nativas (_imaging, libjpeg, zlib, ...). El hook de
# PyInstaller suele recogerlas, pero las incluimos explícitamente para no
# repetir el problema de las DLLs vendor de mysql.
binaries = collect_dynamic_libs('PIL')
binaries += [('C:\\Users\\ralcantara\\AppData\\Local\\Programs\\Python\\Python311\\Lib\\site-packages\\mysql\\vendor\\plugin\\*.dll', 'mysql\\vendor\\plugin'), ('C:\\Users\\ralcantara\\AppData\\Local\\Programs\\Python\\Python311\\Lib\\site-packages\\mysql\\vendor\\*.dll', 'mysql\\vendor')]

# reportlab (generación de formularios PDF): necesita sus datos (fuentes AFM/TTF
# de reportlab/fonts) y la extensión C _rl_accel. collect_all los recoge todos;
# sin las fuentes empaquetadas el worker fallaría al generar el PDF en runtime.
datas = []
_rl_datas, _rl_binaries, _rl_hiddenimports = collect_all('reportlab')
datas += _rl_datas
binaries += _rl_binaries
hiddenimports += _rl_hiddenimports
datas += _p2d_datas
binaries += _p2d_binaries


a = Analysis(
    ['worker_entry.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # pandas/matplotlib: dependencias OPCIONALES que los hooks de fitz/opencv
    # arrastran si están instaladas en dev; el worker no las usa y engordarían
    # el bundle ~40MB. Si algún día una operación las necesita, quitarlas de aquí.
    excludes=['pandas', 'matplotlib'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='comprepdf-worker',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='comprepdf-worker',
)
