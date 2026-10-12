import sys
from pathlib import Path

# The photoreal worker's helpers (atrium_photoreal) sit next to this package.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "photoreal"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
