"""Model file management (download with integrity checks and retries)."""

from __future__ import annotations

import hashlib
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app.utils.errors import ModelError
from app.utils.paths import models_dir

log = logging.getLogger(__name__)

ProgressFn = Callable[[str, int, int], None]


@dataclass(frozen=True)
class ModelFile:
    name: str
    url: str
    sha256: str | None = None
    min_bytes: int = 100_000


YUNET = ModelFile(
    name="face_detection_yunet_2023mar.onnx",
    url="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    min_bytes=200_000,
)
SFACE = ModelFile(
    name="face_recognition_sface_2021dec.onnx",
    url="https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
    min_bytes=30_000_000,
)


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def ensure_model(model: ModelFile, progress: ProgressFn | None = None, retries: int = 3) -> Path:
    """Return the local path of ``model``, downloading it if needed."""
    target = models_dir() / model.name
    if target.exists() and target.stat().st_size >= model.min_bytes:
        if model.sha256 is None or _sha256(target) == model.sha256:
            return target
        log.warning("Checksum mismatch for %s; re-downloading.", target)

    tmp = target.with_suffix(".part")
    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            log.info("Downloading %s (attempt %d/%d)", model.url, attempt, retries)
            with urllib.request.urlopen(model.url, timeout=30) as resp, tmp.open("wb") as out:
                total = int(resp.headers.get("Content-Length") or 0)
                done = 0
                while chunk := resp.read(1 << 16):
                    out.write(chunk)
                    done += len(chunk)
                    if progress:
                        progress(model.name, done, total)
            if tmp.stat().st_size < model.min_bytes:
                raise ModelError(f"Downloaded {model.name} is truncated ({tmp.stat().st_size} bytes).")
            if model.sha256 and _sha256(tmp) != model.sha256:
                raise ModelError(f"Checksum mismatch for {model.name}.")
            tmp.replace(target)
            return target
        except (urllib.error.URLError, OSError, ModelError) as exc:
            last_error = exc
            log.warning("Download failed: %s", exc)
            time.sleep(2**attempt)
    tmp.unlink(missing_ok=True)
    raise ModelError(
        f"Could not download {model.name}: {last_error}. "
        f"Download it manually from {model.url} and place it in {target.parent}."
    )
