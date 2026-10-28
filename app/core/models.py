"""Model file management (download with integrity checks and retries)."""

from __future__ import annotations

import hashlib
import logging
import time
import urllib.error
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from app.utils.errors import ModelError
from app.utils.paths import model_search_dirs, models_dir

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
    for folder in model_search_dirs():
        found = folder / model.name
        if found.exists() and found.stat().st_size >= model.min_bytes:
            return found
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


# InsightFace model packs (released under the InsightFace non-commercial model
# licence - see https://github.com/deepinsight/insightface#license).
INSIGHTFACE_PACKS: dict[str, dict[str, str]] = {
    "buffalo_l": {"det": "det_10g.onnx", "rec": "w600k_r50.onnx"},
    "buffalo_s": {"det": "det_500m.onnx", "rec": "w600k_mbf.onnx"},
}
_PACK_URL = "https://github.com/deepinsight/insightface/releases/download/v0.7/{pack}.zip"


def _pack_complete(folder: Path, pack: str) -> bool:
    return all((folder / f).is_file() and (folder / f).stat().st_size > 1_000_000 for f in INSIGHTFACE_PACKS[pack].values())


def pack_dir(pack: str) -> Path:
    """First folder holding the complete pack (installer copy wins), else the download target."""
    for base in model_search_dirs():
        if _pack_complete(base / "insightface" / pack, pack):
            return base / "insightface" / pack
    return models_dir() / "insightface" / pack


def pack_ready(pack: str) -> bool:
    return _pack_complete(pack_dir(pack), pack)


def ensure_pack(pack: str, progress: ProgressFn | None = None) -> tuple[Path, Path]:
    """Return (detector, recognizer) paths for an InsightFace pack, downloading
    and extracting only the two files the app uses."""
    if pack not in INSIGHTFACE_PACKS:
        raise ModelError(f"Unknown model pack '{pack}'.")
    files = INSIGHTFACE_PACKS[pack]
    target = pack_dir(pack)
    if not pack_ready(pack):
        target.mkdir(parents=True, exist_ok=True)
        archive = ensure_model(
            ModelFile(name=f"{pack}.zip", url=_PACK_URL.format(pack=pack), min_bytes=50_000_000), progress
        )
        try:
            with zipfile.ZipFile(archive) as zf:
                for member in zf.namelist():
                    name = Path(member).name
                    if name in files.values():
                        with zf.open(member) as src, (target / name).open("wb") as dst:
                            while chunk := src.read(1 << 20):
                                dst.write(chunk)
        except zipfile.BadZipFile as exc:
            archive.unlink(missing_ok=True)
            raise ModelError(f"{archive.name} is corrupted; it will be downloaded again next time.") from exc
        archive.unlink(missing_ok=True)
        if not pack_ready(pack):
            raise ModelError(f"{pack}.zip does not contain {', '.join(files.values())}.")
    return target / files["det"], target / files["rec"]
