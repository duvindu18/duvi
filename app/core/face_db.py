"""Local identity database backed by a plain folder structure::

    faces/
        Alice/
            01.jpg
            holiday.png
        Bob/
            portrait.jpg

Each image is embedded once with the active engine; embeddings are cached per
embedding space (``engine.tag``) and invalidated by file size + mtime, so
adding a photo only costs one inference on the next sync.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import shutil
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

import cv2
import numpy as np

from app.utils.imageio import imread, imwrite, is_image
from app.utils.paths import cache_dir

log = logging.getLogger(__name__)

ProgressFn = Callable[[int, int, str], None]
_INVALID_NAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


class EmbeddingEngine(Protocol):
    tag: str

    def detect(self, frame: np.ndarray) -> list: ...

    def embed(self, frame: np.ndarray, detections: list) -> np.ndarray: ...


@dataclass
class PersonInfo:
    name: str
    folder: Path
    image_count: int
    indexed_count: int
    thumbnail: Path | None


def sanitize_name(name: str) -> str:
    cleaned = _INVALID_NAME.sub("", name).strip().rstrip(".")
    if not cleaned:
        raise ValueError("Name is empty after removing invalid characters.")
    return cleaned[:80]


class FaceDatabase:
    def __init__(self, root: str | Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._sync_lock = threading.Lock()  # serialises concurrent syncs (live + export)
        self._gallery = np.zeros((0, 1), np.float32)
        self._labels: list[str] = []
        self._tag: str | None = None
        self._version = 0

    # ---- folder management -------------------------------------------
    def persons(self) -> list[PersonInfo]:
        indexed: dict[str, int] = {}
        with self._lock:
            for label in self._labels:
                indexed[label] = indexed.get(label, 0) + 1
        out = []
        for folder in sorted(p for p in self.root.iterdir() if p.is_dir() and not p.name.startswith(".")):
            images = sorted(p for p in folder.iterdir() if is_image(p))
            out.append(
                PersonInfo(folder.name, folder, len(images), indexed.get(folder.name, 0), images[0] if images else None)
            )
        return out

    def person_names(self) -> list[str]:
        return [p.name for p in self.persons()]

    def add_images(self, name: str, files: list[Path]) -> int:
        folder = self.root / sanitize_name(name)
        folder.mkdir(parents=True, exist_ok=True)
        copied = 0
        for src in files:
            if not is_image(Path(src)):
                continue
            dst = folder / Path(src).name
            if dst.exists():
                dst = folder / f"{dst.stem}_{int(time.time() * 1000)}{dst.suffix}"
            shutil.copy2(src, dst)
            copied += 1
        return copied

    def save_crop(self, name: str, crop: np.ndarray) -> Path:
        folder = self.root / sanitize_name(name)
        path = folder / f"capture_{time.strftime('%Y%m%d_%H%M%S')}_{int(time.time() * 1000) % 1000:03d}.jpg"
        if not imwrite(path, crop):
            raise OSError(f"Could not write {path}")
        return path

    def remove_person(self, name: str) -> None:
        folder = self.root / sanitize_name(name)
        if folder.resolve().parent != self.root.resolve():
            raise ValueError("Refusing to delete outside the faces folder.")
        shutil.rmtree(folder, ignore_errors=False)

    def rename_person(self, old: str, new: str) -> None:
        src = self.root / sanitize_name(old)
        dst = self.root / sanitize_name(new)
        if dst.exists():
            raise FileExistsError(f"'{dst.name}' already exists.")
        src.rename(dst)

    # ---- indexing ------------------------------------------------------
    def _cache_path(self, tag: str) -> Path:
        key = hashlib.sha1(str(self.root.resolve()).encode("utf-8")).hexdigest()[:12]
        return cache_dir() / "embeddings" / f"{key}_{tag}.npz"

    def _load_cache(self, tag: str) -> dict[str, tuple[float, int, np.ndarray | None]]:
        path = self._cache_path(tag)
        if not path.exists():
            return {}
        try:
            with np.load(path, allow_pickle=False) as data:
                meta = json.loads(str(data["meta"]))
                vectors = data["vectors"]
            cache = {}
            for key, (mtime, size, row) in meta.items():
                cache[key] = (mtime, size, vectors[row] if row >= 0 else None)
            return cache
        except Exception as exc:
            log.warning("Embedding cache %s unreadable (%s); rebuilding.", path, exc)
            return {}

    def _save_cache(self, tag: str, cache: dict[str, tuple[float, int, np.ndarray | None]]) -> None:
        meta: dict[str, tuple[float, int, int]] = {}
        vectors: list[np.ndarray] = []
        for key, (mtime, size, vec) in cache.items():
            if vec is None:
                meta[key] = (mtime, size, -1)
            else:
                meta[key] = (mtime, size, len(vectors))
                vectors.append(vec)
        path = self._cache_path(tag)
        path.parent.mkdir(parents=True, exist_ok=True)
        dim = vectors[0].shape[0] if vectors else 1
        arr = np.stack(vectors) if vectors else np.zeros((0, dim), np.float32)
        tmp = path.with_name(path.stem + ".tmp.npz")
        np.savez(tmp, meta=np.array(json.dumps(meta)), vectors=arr)
        tmp.replace(path)

    def sync(self, engine: EmbeddingEngine, progress: ProgressFn | None = None, cancel: threading.Event | None = None) -> int:
        """Bring the in-memory gallery up to date with the folder. Returns #identities."""
        with self._sync_lock:
            return self._sync(engine, progress, cancel)

    def _sync(self, engine: EmbeddingEngine, progress: ProgressFn | None, cancel: threading.Event | None) -> int:
        tag = engine.tag
        cache = self._load_cache(tag)
        files: list[tuple[str, Path]] = []
        for folder in sorted(p for p in self.root.iterdir() if p.is_dir() and not p.name.startswith(".")):
            for img in sorted(folder.iterdir()):
                if is_image(img):
                    files.append((folder.name, img))

        fresh: dict[str, tuple[float, int, np.ndarray | None]] = {}
        labels: list[str] = []
        vectors: list[np.ndarray] = []
        todo = len(files)
        for i, (person, path) in enumerate(files):
            if cancel is not None and cancel.is_set():
                return len(set(self._labels))
            key = f"{person}/{path.name}"
            stat = path.stat()
            cached = cache.get(key)
            if cached is not None and cached[0] == stat.st_mtime and cached[1] == stat.st_size:
                vec = cached[2]
            else:
                vec = self._embed_file(engine, path)
                if vec is None:
                    log.warning("No usable face found in %s", path)
            fresh[key] = (stat.st_mtime, stat.st_size, vec)
            if vec is not None:
                labels.append(person)
                vectors.append(vec.astype(np.float32))
            if progress:
                progress(i + 1, todo, key)

        self._save_cache(tag, fresh)
        with self._lock:
            self._labels = labels
            self._gallery = np.stack(vectors) if vectors else np.zeros((0, 1), np.float32)
            self._tag = tag
            self._version += 1
        log.info("Face database: %d embeddings for %d identities (%s)", len(labels), len(set(labels)), tag)
        return len(set(labels))

    @staticmethod
    def _embed_file(engine: EmbeddingEngine, path: Path) -> np.ndarray | None:
        img = imread(path)
        if img is None:
            return None
        # Very large photos slow detection without improving the embedding.
        h, w = img.shape[:2]
        if max(h, w) > 1600:
            s = 1600 / max(h, w)
            img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
        dets = engine.detect(img)
        if not dets:
            # Tight crops (e.g. enrolment captures) may need context to be detected.
            pad = max(img.shape[:2]) // 2
            img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(0, 0, 0))
            dets = engine.detect(img)
            if not dets:
                return None
        best = max(dets, key=lambda d: d.width * d.height * d.score)
        emb = engine.embed(img, [best])
        if emb.shape[0] == 0 or not np.any(emb[0]):
            return None
        return emb[0]

    # ---- matching ------------------------------------------------------
    @property
    def tag(self) -> str | None:
        return self._tag

    @property
    def version(self) -> int:
        return self._version

    @property
    def identity_count(self) -> int:
        return len(set(self._labels))

    @property
    def size(self) -> int:
        return len(self._labels)

    def match(self, embeddings: np.ndarray, threshold: float) -> list[tuple[str | None, float]]:
        """Best identity per embedding (``None`` below ``threshold``)."""
        with self._lock:
            gallery, labels = self._gallery, list(self._labels)
        if len(embeddings) == 0:
            return []
        if not labels or gallery.shape[1] != embeddings.shape[1]:
            return [(None, 0.0)] * len(embeddings)
        sims = embeddings @ gallery.T  # cosine similarity (all vectors are L2-normalised)
        out: list[tuple[str | None, float]] = []
        for row in sims:
            j = int(np.argmax(row))
            best = float(row[j])
            out.append((labels[j] if best >= threshold else None, best))
        return out
