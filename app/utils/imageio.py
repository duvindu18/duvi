"""Unicode-safe image I/O.

``cv2.imread``/``cv2.imwrite`` use narrow-char paths on Windows and silently fail
for folders such as ``C:\\Users\\José\\Pictures``. Reading through NumPy avoids that.
"""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"}


def imread(path: str | Path, flags: int = cv2.IMREAD_COLOR) -> np.ndarray | None:
    try:
        data = np.fromfile(str(path), dtype=np.uint8)
    except OSError:
        return None
    if data.size == 0:
        return None
    return cv2.imdecode(data, flags)


def imwrite(path: str | Path, image: np.ndarray, quality: int = 95) -> bool:
    path = Path(path)
    ext = path.suffix.lower() or ".jpg"
    params = [cv2.IMWRITE_JPEG_QUALITY, quality] if ext in (".jpg", ".jpeg") else []
    ok, buf = cv2.imencode(ext, image, params)
    if not ok:
        return False
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        buf.tofile(str(path))
    except OSError:
        return False
    return True


def is_image(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS
