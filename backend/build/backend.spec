# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec — builds backend.exe from the Python port.

Build (from backend/, with the venv active):
    pyinstaller --noconfirm --clean build/backend.spec

Output: dist/backend/backend.exe (+ _internal/) — a portable, dependency-free
server. The Electron GUI spawns this exe instead of `bun run src/index.ts`.

The exe reads the same env vars as the TS backend (PORT, DATA_DIR,
GENERATED_IMAGES_DIR, SSL_CERT, SSL_KEY, OLLAMA_URL, ...) so the GUI's spawn
logic stays almost unchanged.
"""

import os

block_cipher = None

a = Analysis(
    ["../run_server.py"],
    pathex=[".."],
    binaries=[],
    datas=[
        # Templates/static shipped inside the package (kept inline in TS — the
        # Python port renders the download page from code, so no extra data
        # files are strictly required).
    ],
    hiddenimports=[
        "uvicorn",
        "uvicorn.logging",
        "uvicorn.loops",
        "uvicorn.loops.auto",
        "uvicorn.protocols",
        "uvicorn.protocols.http",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan",
        "uvicorn.lifespan.on",
        "fastapi",
        "ddgs",
        "lxml",
        "primp",
        "pydantic",
        "argon2",
        "argon2.low_level",
        "cryptography",
        "resvg_py",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # Dev-only / unused packages the exe never imports — keeps the bundle
    # smaller and speeds up Analysis.
    excludes=[
        "pytest",
        "pytest_asyncio",
        "watchfiles",
        "setuptools",
        "pip",
        "wheel",
        "tkinter",
        "unittest",
        "pydoc_data",
        "lib2to3",
        "xmlrpc",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="backend",
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
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="backend",
)