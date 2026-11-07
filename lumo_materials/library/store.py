"""The material library on disk.

    <library>\\
      library.json                     categories (order), tag index, settings (rebuilt from the folders if lost)
      _Trash\\<id>\\                     deleted materials until the trash is emptied (+ trash.json)
      Materials\\<Category>\\<Material>\\
          material.json                name, category, tags, description, favourite, generation, adjustments, seam score
          albedo.png normal.png roughness.png metallic.png height.png (16-bit) ao.png
          thumb.jpg preview_sphere.png preview_plane.png
          source\\original.<ext>         the photo it was made from
          originals\\*.png               untouched maps, kept while the material is adjusted

The file system is the source of truth: folders renamed, moved or copied in Explorer are picked up by rescan().
"""
from __future__ import annotations

import dataclasses
import datetime as dt
import shutil
import threading
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

import numpy as np

from ..engine import adjust as adj
from ..engine import imageio, render
from ..engine.fftops import parallel
from ..engine.seamless import seam_score
from .paths import is_inside, refuse_reason, safe_name, unique_child
from .settings import read_json, write_json_atomic

LIBRARY_FILE = "library.json"
MATERIALS = "Materials"
TRASH = "_Trash"
UNCATEGORIZED = "Uncategorized"
DEFAULT_CATEGORIES = ("Walls", "Floors", "Stone", "Metal", "Wood", "Tiles", "Fabric", "Ground", UNCATEGORIZED)
MAP_FILES = {"albedo": "albedo.png", "normal": "normal.png", "roughness": "roughness.png",
             "metallic": "metallic.png", "height": "height.png", "ao": "ao.png"}
PREVIEW_FILES = {"thumb": "thumb.jpg", "sphere": "preview_sphere.png", "plane": "preview_plane.png"}
MAX_TAGS = 24
FORMAT_VERSION = 1


class LibraryError(Exception):
    def __init__(self, message: str, code: str = "error"):
        super().__init__(message)
        self.code = code


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean_tags(tags: Iterable[str]) -> list[str]:
    out: list[str] = []
    for t in tags:
        t = " ".join(str(t).lower().replace(",", " ").split()).strip()
        if t and t not in out and len(t) <= 40:
            out.append(t)
    return out[:MAX_TAGS]


@dataclass
class Material:
    id: str
    name: str
    category: str
    folder: Path
    tags: list[str] = field(default_factory=list)
    description: str = ""
    favourite: bool = False
    created: str = ""
    modified: str = ""
    width: int = 0
    height: int = 0
    seam_score: float | None = None
    origin: str = "photo"                          # photo | import
    generation: dict[str, Any] | None = None       # GenParams.to_dict() for photo materials
    adjustments: dict[str, Any] | None = None      # adjust params when adjusted (originals\ then exists)

    def to_json(self) -> dict[str, Any]:
        return {
            "format": FORMAT_VERSION, "id": self.id, "name": self.name, "category": self.category,
            "tags": self.tags, "description": self.description, "favourite": self.favourite,
            "created": self.created, "modified": self.modified, "width": self.width, "height": self.height,
            "seam_score": self.seam_score, "origin": self.origin,
            "generation": self.generation, "adjustments": self.adjustments,
        }

    @property
    def size_label(self) -> str:
        e = max(self.width, self.height)
        if e >= 3800:
            return "4K"
        if e >= 1900:
            return "2K"
        if e >= 900:
            return "1K"
        return f"{e}px" if e else "?"

    def file(self, name: str) -> Path:
        return self.folder / name

    def preview_path(self, kind: str = "sphere") -> Path | None:
        p = self.folder / PREVIEW_FILES[kind]
        if p.exists():
            return p
        t = self.folder / PREVIEW_FILES["thumb"]
        return t if t.exists() else None

    @property
    def source_path(self) -> Path | None:
        src = self.folder / "source"
        if src.is_dir():
            for p in sorted(src.iterdir()):
                if p.is_file() and p.stem == "original":
                    return p
        return None

    @property
    def has_originals(self) -> bool:
        return (self.folder / "originals").is_dir()

    def searchable(self) -> str:
        return " ".join([self.name, self.category, self.description, *self.tags]).lower()


@dataclass
class TrashItem:
    id: str
    name: str
    category: str
    deleted: str
    folder: Path


def inspect_folder(folder: str | Path, app_dir: str | Path | None = None) -> dict[str, Any]:
    """What choosing this folder would mean: library | empty | new | other | refused."""
    p = Path(folder).expanduser()
    reason = refuse_reason(p, app_dir)
    if reason:
        return {"state": "refused", "reason": reason, "path": str(p)}
    if not p.exists():
        return {"state": "new", "path": str(p)}
    if not p.is_dir():
        return {"state": "refused", "reason": "This is a file, not a folder.", "path": str(p)}
    if (p / LIBRARY_FILE).exists() or (p / MATERIALS).is_dir():
        n = sum(1 for _ in (p / MATERIALS).glob("*/*/material.json")) if (p / MATERIALS).is_dir() else 0
        return {"state": "library", "materials": n, "path": str(p)}
    try:
        empty = not any(p.iterdir())
    except OSError as e:
        return {"state": "refused", "reason": f"The folder cannot be read ({e}).", "path": str(p)}
    return {"state": "empty" if empty else "other", "path": str(p)}


class Library:
    """Thread-safe access to one library folder."""

    def __init__(self, root: str | Path, create: bool = False, app_dir: str | Path | None = None):
        self.root = Path(root).expanduser().resolve()
        reason = refuse_reason(self.root, app_dir)
        if reason:
            raise LibraryError(reason, "refused")
        self._lock = threading.RLock()
        if not (self.root / MATERIALS).is_dir() and not (self.root / LIBRARY_FILE).exists():
            if not create:
                raise LibraryError(f"{self.root} is not a lumo material library.", "not_library")
        (self.root / MATERIALS).mkdir(parents=True, exist_ok=True)
        (self.root / TRASH).mkdir(exist_ok=True)
        self.meta: dict[str, Any] = read_json(self.root / LIBRARY_FILE, None) or {}
        if not isinstance(self.meta.get("categories"), list):
            self.meta["categories"] = list(DEFAULT_CATEGORIES)
        self.meta.setdefault("settings", {})
        self._materials: dict[str, Material] = {}
        self.rescan()

    # ------------------------------------------------------------------ index
    @property
    def materials_dir(self) -> Path:
        return self.root / MATERIALS

    @property
    def trash_dir(self) -> Path:
        return self.root / TRASH

    def _save_meta(self) -> None:
        tags: dict[str, int] = {}
        for m in self._materials.values():
            for t in m.tags:
                tags[t] = tags.get(t, 0) + 1
        self.meta.update({"app": "lumo-materials", "format": FORMAT_VERSION, "tags": dict(sorted(tags.items()))})
        write_json_atomic(self.root / LIBRARY_FILE, self.meta)

    def _write_material(self, m: Material) -> None:
        write_json_atomic(m.folder / "material.json", m.to_json())

    def _read_material(self, folder: Path, category: str) -> Material | None:
        data = read_json(folder / "material.json", None)
        if not isinstance(data, dict):
            if not (folder / MAP_FILES["albedo"]).exists():
                return None
            data = {}  # adopt a folder of maps copied in by hand
        m = Material(
            id=str(data.get("id") or uuid.uuid4().hex), name=folder.name, category=category, folder=folder,
            tags=clean_tags(data.get("tags") or []), description=str(data.get("description") or ""),
            favourite=bool(data.get("favourite")), created=str(data.get("created") or now_iso()),
            modified=str(data.get("modified") or data.get("created") or now_iso()),
            width=int(data.get("width") or 0), height=int(data.get("height") or 0),
            seam_score=data.get("seam_score"), origin=str(data.get("origin") or "photo"),
            generation=data.get("generation"), adjustments=data.get("adjustments"),
        )
        if not m.width and (folder / MAP_FILES["albedo"]).exists():
            try:
                from PIL import Image
                with Image.open(folder / MAP_FILES["albedo"]) as im:
                    m.width, m.height = im.size
            except Exception:
                pass
        changed = (data.get("name") != m.name or data.get("category") != m.category or not data.get("id"))
        return m if not changed else self._mark_dirty(m)

    def _mark_dirty(self, m: Material) -> Material:
        m._dirty = True  # type: ignore[attr-defined]
        return m

    def rescan(self) -> int:
        """Re-reads every folder. Returns the number of materials."""
        with self._lock:
            candidates: list[tuple[Material, bool, float]] = []
            for cat_dir in sorted(p for p in self.materials_dir.iterdir() if p.is_dir() and not p.name.startswith(".")):
                if cat_dir.name not in self.meta["categories"]:
                    self.meta["categories"].append(cat_dir.name)
                for mdir in sorted(p for p in cat_dir.iterdir() if p.is_dir() and not p.name.startswith(".")):
                    stored_name = json_name(mdir)
                    m = self._read_material(mdir, cat_dir.name)
                    if m is None:
                        continue
                    try:
                        st = mdir.stat()
                        born = float(getattr(st, "st_birthtime", st.st_ctime))
                    except OSError:
                        born = 0.0
                    candidates.append((m, stored_name == mdir.name, born))
            # A folder copied in Explorer carries the same id: the folder whose name matches its stored name
            # keeps it, otherwise the oldest folder; every other copy gets an id of its own.
            candidates.sort(key=lambda c: (not c[1], c[2]))
            found: dict[str, Material] = {}
            for m, _, _ in candidates:
                if m.id in found:
                    m.id = uuid.uuid4().hex
                    self._mark_dirty(m)
                if getattr(m, "_dirty", False):
                    try:
                        self._write_material(m)
                    except OSError:
                        pass
                found[m.id] = m
            if UNCATEGORIZED not in self.meta["categories"]:
                self.meta["categories"].append(UNCATEGORIZED)
            self._materials = found
            try:
                self._save_meta()
            except OSError:
                pass
            return len(found)

    # ------------------------------------------------------------------ queries
    def get(self, mid: str) -> Material:
        try:
            return self._materials[mid]
        except KeyError:
            raise LibraryError("This material no longer exists. Press Rescan.", "not_found") from None

    def all(self) -> list[Material]:
        return list(self._materials.values())

    def count(self) -> int:
        return len(self._materials)

    def categories(self) -> list[tuple[str, int]]:
        counts: dict[str, int] = {c: 0 for c in self.meta["categories"]}
        for m in self._materials.values():
            counts[m.category] = counts.get(m.category, 0) + 1
        return list(counts.items())

    def tags(self) -> list[tuple[str, int]]:
        counts: dict[str, int] = {}
        for m in self._materials.values():
            for t in m.tags:
                counts[t] = counts.get(t, 0) + 1
        return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))

    def query(self, search: str = "", category: str | None = None, tags: Iterable[str] = (),
              favourites: bool = False, sort: str = "recent", recent_days: int | None = None) -> list[Material]:
        words = [w for w in search.lower().split() if w]
        want_tags = set(clean_tags(tags))
        cutoff = None
        if recent_days:
            cutoff = (dt.datetime.now(dt.timezone.utc).replace(microsecond=0) - dt.timedelta(days=recent_days)).isoformat()
        out = []
        for m in self._materials.values():
            if category and m.category != category:
                continue
            if favourites and not m.favourite:
                continue
            if want_tags and not want_tags.issubset(m.tags):
                continue
            if words:
                hay = m.searchable()
                if not all(w in hay for w in words):
                    continue
            if cutoff and m.created.replace("Z", "+00:00") < cutoff:
                continue
            out.append(m)
        keys: dict[str, tuple[Callable[[Material], Any], bool]] = {
            "recent": (lambda m: m.created, True),
            "modified": (lambda m: m.modified, True),
            "name": (lambda m: m.name.lower(), False),
            "category": (lambda m: (m.category.lower(), m.name.lower()), False),
            "size": (lambda m: (m.width * m.height, m.name.lower()), True),
        }
        key, rev = keys.get(sort, keys["recent"])
        out.sort(key=key, reverse=rev)
        return out

    def disk_usage(self) -> int:
        total = 0
        for p in self.materials_dir.rglob("*"):
            try:
                if p.is_file():
                    total += p.stat().st_size
            except OSError:
                pass
        return total

    # ------------------------------------------------------------------ maps
    def load_maps(self, mid: str, max_edge: int | None = None, originals: bool = False) -> dict[str, np.ndarray]:
        m = self.get(mid)
        base = m.folder / "originals" if (originals and m.has_originals) else m.folder
        out: dict[str, np.ndarray] = {}
        for name, fname in MAP_FILES.items():
            p = base / fname
            if not p.exists():
                p = m.folder / fname
            if not p.exists():
                continue
            a = imageio.load_rgb(p) if name in ("albedo", "normal") else imageio.load_gray(p)
            out[name] = imageio.fit_within(a, max_edge) if max_edge else a
        missing = [n for n in MAP_FILES if n not in out]
        if "albedo" in missing:
            raise LibraryError(f"{m.name} has no albedo.png.", "broken")
        h, w = out["albedo"].shape[:2]
        defaults = {"normal": (0.5, 0.5, 1.0), "roughness": 0.7, "metallic": 0.0, "height": 0.5, "ao": 1.0}
        for n in missing:
            v = defaults[n]
            out[n] = (np.tile(np.array(v, np.float32), (h, w, 1)) if isinstance(v, tuple)
                      else np.full((h, w), v, np.float32))
        return out

    def load_preview_u8(self, mid: str, edge: int = 1024) -> dict[str, np.ndarray]:
        """The six maps as small uint8 arrays for the 3D preview (RGBA for albedo / normal, single channel for the
        rest). Decoded straight to 8 bit with whole-number reduction while reading: several times faster than
        load_maps(max_edge=...), which works in float at full size."""
        from PIL import Image
        import io as _io
        m = self.get(mid)
        defaults = {"albedo": (128, 128, 128, 255), "normal": (128, 128, 255, 255), "roughness": 178, "metallic": 0,
                    "height": 128, "ao": 255}

        def read(name: str):
            p = m.folder / MAP_FILES[name]
            if not p.exists():
                return name, None
            im = Image.open(_io.BytesIO(p.read_bytes()))
            factor = max(1, max(im.size) // edge)
            if im.mode in ("I;16", "I;16B", "I;16L", "I"):
                a = np.asarray(im)
                a = (a.astype(np.uint32) >> 8).astype(np.uint8) if a.max() > 255 else a.astype(np.uint8)
                im = Image.fromarray(a, "L")
            elif name in ("albedo", "normal"):
                im = im.convert("RGB")
            else:
                im = im.convert("L")
            if factor > 1:
                im = im.reduce(factor)
            if max(im.size) > edge:
                im.thumbnail((edge, edge), Image.BILINEAR)
            if name in ("albedo", "normal"):
                im = im.convert("RGBA")
            return name, np.ascontiguousarray(np.asarray(im))

        out = {k: v for k, v in parallel(read, list(MAP_FILES)) if v is not None}
        if "albedo" not in out:
            raise LibraryError(f"{m.name} has no albedo.png.", "broken")
        h, w = out["albedo"].shape[:2]
        for name, val in defaults.items():
            if name not in out:
                out[name] = (np.tile(np.array(val, np.uint8), (h, w, 1)) if isinstance(val, tuple)
                             else np.full((h, w), val, np.uint8))
            elif out[name].shape[:2] != (h, w):      # maps of different sizes: match the albedo
                mode = "RGBA" if out[name].ndim == 3 else "L"
                out[name] = np.asarray(Image.fromarray(out[name], mode).resize((w, h), Image.BILINEAR))
        return out

    @staticmethod
    def _write_maps(folder: Path, maps: dict[str, np.ndarray]) -> None:
        """Writes the six PNGs in parallel (Pillow compresses without holding the GIL)."""
        def write(item):
            name, fname = item
            if name == "height":
                imageio.save_png16(maps[name], folder / fname)
            else:
                imageio.save_png8(maps[name], folder / fname)
        parallel(write, [(n, f) for n, f in MAP_FILES.items() if n in maps])

    @staticmethod
    def write_previews(folder: Path, maps: dict[str, np.ndarray], size: int = 384) -> None:
        # a 384 px preview needs no more than 512 px textures: shrink first (fast box filter)
        maps = {k: imageio.shrink(v, 512) for k, v in maps.items()}
        sph = render.sphere(maps, size=size)
        imageio.save_rgba_png(sph, folder / PREVIEW_FILES["sphere"])
        imageio.save_jpg(render.plane(maps, size=size), folder / PREVIEW_FILES["plane"], quality=88)
        thumb = imageio.resize(render.composite(sph), 256, 256)
        imageio.save_jpg(thumb, folder / PREVIEW_FILES["thumb"], quality=88)

    def set_preview(self, mid: str, kind: str, png_bytes: bytes) -> None:
        """Stores a preview rendered elsewhere (e.g. by the GPU viewer)."""
        if kind not in ("sphere", "plane"):
            raise LibraryError("Unknown preview kind.", "bad_request")
        m = self.get(mid)
        tmp = m.folder / (PREVIEW_FILES[kind] + ".tmp")
        tmp.write_bytes(png_bytes)
        tmp.replace(m.folder / PREVIEW_FILES[kind])

    # ------------------------------------------------------------------ create
    def _category_dir(self, category: str) -> tuple[str, Path]:
        cat = safe_name(category or UNCATEGORIZED, UNCATEGORIZED)
        d = self.materials_dir / cat
        d.mkdir(parents=True, exist_ok=True)
        if cat not in self.meta["categories"]:
            self.meta["categories"].append(cat)
        return cat, d

    def create(self, maps: dict[str, np.ndarray], name: str, category: str, *, tags: Iterable[str] = (),
               description: str = "", favourite: bool = False, origin: str = "photo",
               generation: dict[str, Any] | None = None, source: str | Path | None = None,
               originals: dict[str, np.ndarray] | None = None, adjustments: dict[str, Any] | None = None,
               progress: Callable[[float, str], None] | None = None) -> Material:
        """Writes a new material folder. maps = final maps; originals + adjustments for adjusted materials."""
        report = progress or (lambda f, s: None)
        with self._lock:
            cat, cdir = self._category_dir(category)
            folder = unique_child(cdir, safe_name(name))
            staging = cdir / f".{folder.name}.saving-{uuid.uuid4().hex[:8]}"
        staging.mkdir(parents=True)
        try:
            report(0.05, "Writing maps")
            self._write_maps(staging, maps)
            if originals is not None and adjustments is not None and not adj.is_neutral(adjustments):
                report(0.45, "Keeping the untouched maps")
                (staging / "originals").mkdir()
                self._write_maps(staging / "originals", originals)
            else:
                adjustments = None
            if source:
                sp = Path(source)
                (staging / "source").mkdir()
                shutil.copy2(sp, staging / "source" / ("original" + sp.suffix.lower()))
            report(0.7, "Rendering previews")
            self.write_previews(staging, maps)
            h, w = maps["albedo"].shape[:2]
            ts = now_iso()
            m = Material(id=uuid.uuid4().hex, name=folder.name, category=cat, folder=folder, tags=clean_tags(tags),
                         description=description, favourite=favourite, created=ts, modified=ts, width=w, height=h,
                         seam_score=round(seam_score(maps["albedo"]), 3), origin=origin, generation=generation,
                         adjustments=adj.normalize(adjustments) if adjustments else None)
            m.folder = staging
            self._write_material(m)
            with self._lock:
                folder = unique_child(cdir, folder.name)
                staging.rename(folder)
                m.folder, m.name = folder, folder.name
                if m.name != json_name(folder):
                    self._write_material(m)
                self._materials[m.id] = m
                self._save_meta()
            report(1.0, "Saved")
            return m
        except BaseException:
            shutil.rmtree(staging, ignore_errors=True)
            raise

    def replace_maps(self, mid: str, maps: dict[str, np.ndarray], *, originals: dict[str, np.ndarray] | None = None,
                     adjustments: dict[str, Any] | None = None, generation: dict[str, Any] | None = None,
                     source: str | Path | None = None, progress: Callable[[float, str], None] | None = None) -> Material:
        """Overwrites the maps of an existing material (regenerate, or save an adjustment as 'replace')."""
        report = progress or (lambda f, s: None)
        with self._lock:
            m = self.get(mid)
        report(0.05, "Writing maps")
        if adjustments is not None and not adj.is_neutral(adjustments):
            if not m.has_originals:   # first adjustment: keep what is there now as the untouched set
                o = m.folder / "originals"
                o.mkdir(exist_ok=True)
                if originals is not None:
                    self._write_maps(o, originals)
                else:
                    for fname in MAP_FILES.values():
                        if (m.folder / fname).exists():
                            shutil.copy2(m.folder / fname, o / fname)
            self._write_maps(m.folder, maps)
            m.adjustments = adj.normalize(adjustments)
        else:
            # neutral adjustment, or a regenerate: the given maps are the new untouched state
            self._write_maps(m.folder, maps)
            if m.has_originals:
                shutil.rmtree(m.folder / "originals", ignore_errors=True)
            m.adjustments = None
        if generation is not None:
            m.generation = generation
        if source:
            sp = Path(source)
            sdir = m.folder / "source"
            if sdir.exists() and m.source_path and m.source_path.resolve() == sp.resolve():
                pass
            else:
                shutil.rmtree(sdir, ignore_errors=True)
                sdir.mkdir()
                shutil.copy2(sp, sdir / ("original" + sp.suffix.lower()))
        report(0.7, "Rendering previews")
        self.write_previews(m.folder, maps)
        h, w = maps["albedo"].shape[:2]
        m.width, m.height = w, h
        m.seam_score = round(seam_score(maps["albedo"]), 3)
        m.modified = now_iso()
        with self._lock:
            self._write_material(m)
            self._save_meta()
        report(1.0, "Saved")
        return m

    def duplicate(self, mid: str, name: str | None = None, category: str | None = None) -> Material:
        with self._lock:
            src = self.get(mid)
            cat, cdir = self._category_dir(category or src.category)
            folder = unique_child(cdir, safe_name(name or f"{src.name} copy"))
            shutil.copytree(src.folder, folder)
            ts = now_iso()
            m = dataclasses.replace(src, id=uuid.uuid4().hex, name=folder.name, category=cat, folder=folder,
                                    created=ts, modified=ts, favourite=False, tags=list(src.tags))
            self._write_material(m)
            self._materials[m.id] = m
            self._save_meta()
            return m

    # ------------------------------------------------------------------ edit
    def update(self, mid: str, *, name: str | None = None, category: str | None = None,
               tags: Iterable[str] | None = None, description: str | None = None,
               favourite: bool | None = None) -> Material:
        with self._lock:
            m = self.get(mid)
            if category is not None and safe_name(category, UNCATEGORIZED) != m.category:
                cat, cdir = self._category_dir(category)
                target = unique_child(cdir, safe_name(name) if name else m.name)
                shutil.move(str(m.folder), str(target))
                m.folder, m.category, m.name = target, cat, target.name
            elif name is not None and safe_name(name) != m.name:
                target = unique_child(m.folder.parent, safe_name(name), exclude=m.folder)
                if target.name != m.folder.name:      # compare names: Windows paths compare case-insensitively
                    if target.name.lower() == m.folder.name.lower():   # case-only rename on Windows
                        tmp = m.folder.with_name(m.folder.name + f".rename-{uuid.uuid4().hex[:6]}")
                        m.folder.rename(tmp)
                        tmp.rename(target)
                    else:
                        m.folder.rename(target)
                    m.folder, m.name = target, target.name
            if tags is not None:
                m.tags = clean_tags(tags)
            if description is not None:
                m.description = str(description)[:2000]
            if favourite is not None:
                m.favourite = bool(favourite)
            m.modified = now_iso()
            self._write_material(m)
            self._save_meta()
            return m

    def bulk(self, ids: Iterable[str], *, category: str | None = None, add_tags: Iterable[str] = (),
             remove_tags: Iterable[str] = (), favourite: bool | None = None) -> list[Material]:
        out = []
        add, rem = clean_tags(add_tags), set(clean_tags(remove_tags))
        for mid in list(ids):
            m = self.get(mid)
            tags = None
            if add or rem:
                tags = [t for t in m.tags if t not in rem] + [t for t in add if t not in m.tags]
            out.append(self.update(mid, category=category, tags=tags, favourite=favourite))
        return out

    # ------------------------------------------------------------------ categories
    def create_category(self, name: str) -> str:
        with self._lock:
            cat = safe_name(name, "")
            if not cat:
                raise LibraryError("Give the category a name.", "bad_request")
            if any(c.lower() == cat.lower() for c in self.meta["categories"]):
                raise LibraryError(f"A category called {cat} already exists.", "exists")
            (self.materials_dir / cat).mkdir(parents=True, exist_ok=True)
            self.meta["categories"].append(cat)
            self._save_meta()
            return cat

    def rename_category(self, old: str, new: str) -> str:
        with self._lock:
            if old == UNCATEGORIZED:
                raise LibraryError("Uncategorized cannot be renamed.", "bad_request")
            new_c = safe_name(new, "")
            if not new_c:
                raise LibraryError("Give the category a name.", "bad_request")
            if new_c.lower() != old.lower() and any(c.lower() == new_c.lower() for c in self.meta["categories"]):
                raise LibraryError(f"A category called {new_c} already exists.", "exists")
            src = self.materials_dir / old
            dst = self.materials_dir / new_c
            if src.exists():
                tmp = src.with_name(src.name + f".rename-{uuid.uuid4().hex[:6]}")
                src.rename(tmp)
                tmp.rename(dst)
            else:
                dst.mkdir(parents=True, exist_ok=True)
            self.meta["categories"] = [new_c if c == old else c for c in self.meta["categories"]]
            for m in self._materials.values():
                if m.category == old:
                    m.category = new_c
                    m.folder = dst / m.folder.name
                    self._write_material(m)
            self._save_meta()
            return new_c

    def delete_category(self, name: str) -> int:
        """Moves its materials to Uncategorized and removes the category. Returns how many were moved."""
        with self._lock:
            if name == UNCATEGORIZED:
                raise LibraryError("Uncategorized cannot be deleted.", "bad_request")
            moved = 0
            for m in [m for m in self._materials.values() if m.category == name]:
                self.update(m.id, category=UNCATEGORIZED)
                moved += 1
            d = self.materials_dir / name
            if d.exists():
                leftovers = [p for p in d.iterdir()]
                if leftovers:   # unknown files stay: move them along instead of deleting
                    keep = unique_child(self.materials_dir / UNCATEGORIZED, safe_name(f"{name} (left over)"))
                    shutil.move(str(d), str(keep))
                else:
                    d.rmdir()
            self.meta["categories"] = [c for c in self.meta["categories"] if c != name]
            self._save_meta()
            return moved

    def reorder_categories(self, order: list[str]) -> None:
        with self._lock:
            known = self.meta["categories"]
            self.meta["categories"] = [c for c in order if c in known] + [c for c in known if c not in order]
            self._save_meta()

    # ------------------------------------------------------------------ trash
    def trash(self, ids: Iterable[str]) -> int:
        n = 0
        with self._lock:
            for mid in list(ids):
                m = self.get(mid)
                dest = self.trash_dir / mid
                if dest.exists():
                    dest = self.trash_dir / f"{mid}-{uuid.uuid4().hex[:6]}"
                shutil.move(str(m.folder), str(dest))
                write_json_atomic(dest / "trash.json", {"id": mid, "name": m.name, "category": m.category,
                                                        "deleted": now_iso()})
                del self._materials[mid]
                n += 1
            self._save_meta()
        return n

    def trash_items(self) -> list[TrashItem]:
        out = []
        for d in sorted(p for p in self.trash_dir.iterdir() if p.is_dir()):
            info = read_json(d / "trash.json", {}) or {}
            mj = read_json(d / "material.json", {}) or {}
            out.append(TrashItem(id=d.name, name=str(info.get("name") or mj.get("name") or d.name),
                                 category=str(info.get("category") or mj.get("category") or UNCATEGORIZED),
                                 deleted=str(info.get("deleted") or ""), folder=d))
        out.sort(key=lambda t: t.deleted, reverse=True)
        return out

    def restore(self, trash_id: str) -> Material:
        with self._lock:
            d = self.trash_dir / trash_id
            if not d.is_dir() or not is_inside(d, self.trash_dir):
                raise LibraryError("This item is no longer in the trash.", "not_found")
            item = next((t for t in self.trash_items() if t.id == trash_id), None)
            cat, cdir = self._category_dir(item.category if item else UNCATEGORIZED)
            target = unique_child(cdir, safe_name(item.name if item else trash_id))
            (d / "trash.json").unlink(missing_ok=True)
            shutil.move(str(d), str(target))
            m = self._read_material(target, cat)
            if m is None:
                raise LibraryError("The restored folder holds no material.", "broken")
            if m.id in self._materials:
                m.id = uuid.uuid4().hex
            m.name, m.category, m.folder = target.name, cat, target
            self._write_material(m)
            self._materials[m.id] = m
            self._save_meta()
            return m

    def delete_forever(self, trash_id: str) -> None:
        d = self.trash_dir / trash_id
        if d.is_dir() and is_inside(d, self.trash_dir) and d != self.trash_dir:
            shutil.rmtree(d)

    def empty_trash(self) -> int:
        items = self.trash_items()
        for t in items:
            self.delete_forever(t.id)
        return len(items)


def json_name(folder: Path) -> str | None:
    data = read_json(folder / "material.json", None)
    return data.get("name") if isinstance(data, dict) else None


def prepare_folder(folder: str | Path, app_dir: str | Path | None = None) -> Library:
    """Turns a chosen folder into a library (adds Materials\\ and library.json; existing files are left alone)."""
    info = inspect_folder(folder, app_dir)
    if info["state"] == "refused":
        raise LibraryError(info["reason"], "refused")
    return Library(folder, create=True, app_dir=app_dir)
