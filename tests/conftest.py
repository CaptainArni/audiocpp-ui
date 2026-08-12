"""Make `backend/` importable from the tests.

The backend modules import each other flatly (`import chat`, `from config import
AppConfig`) because uvicorn is started with `backend/` as the working directory.
Rather than rewrite all of that into a package for the sake of tests, put the
same directory on the path here.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))
