"""Bootstrap entry point for the packaged backend.exe.

main.py uses package-relative imports (from .config, ...), so it must be run as
the `app.main` package — not as a top-level script. PyInstaller's Analysis is
pointed at this file, which imports app.main and delegates to its main().
"""

import sys
from pathlib import Path

# Ensure the backend root is importable so `app` resolves in the frozen exe.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.main import main  # noqa: E402

if __name__ == "__main__":
    main()