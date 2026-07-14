# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_dynamic_libs, collect_submodules

hiddenimports = []
hiddenimports += collect_submodules('mysql.connector')
hiddenimports += collect_submodules('PIL')

# Pillow trae extensiones nativas (_imaging, libjpeg, zlib, ...). El hook de
# PyInstaller suele recogerlas, pero las incluimos explícitamente para no
# repetir el problema de las DLLs vendor de mysql.
binaries = collect_dynamic_libs('PIL')
binaries += [('C:\\Users\\ralcantara\\AppData\\Local\\Programs\\Python\\Python311\\Lib\\site-packages\\mysql\\vendor\\plugin\\*.dll', 'mysql\\vendor\\plugin'), ('C:\\Users\\ralcantara\\AppData\\Local\\Programs\\Python\\Python311\\Lib\\site-packages\\mysql\\vendor\\*.dll', 'mysql\\vendor')]


a = Analysis(
    ['worker_entry.py'],
    pathex=[],
    binaries=binaries,
    datas=[],
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
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
