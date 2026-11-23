"""Asset-library awareness: find textures and models anywhere in a library.

MaxTree, Evermotion, Globe Plants and similar packs keep models and maps in
sibling folders, for example::

    MT_PM_V16/                         MaxTree vol. 16/
      MT_PM_V16_Maps/                    Maps/
      MT_PM_V16_Forest_Pack_Mesh_Corona/ FBX/
      MT_PM_V16_GrowFX/                  Mesh/
      MT_PM_V16_Material_Librarys/       Scene Vray/
      D5/                                Material Librarys/

Texture paths stored in the .max / .fbx usually point at the author's PC
(``D:\\Work\\MaxTree\\maps\\leaf_01.jpg``). This module finds the library
root, indexes every image once, and re-links missing textures by file name,
then by name without extension (``.tif`` vs ``.jpg``), then by a normalised
name (``Leaf_01_4K_diffuse`` == ``leaf01-diffuse``). Materials with no maps at
all get textures matched by their own name.
"""
from __future__ import annotations

import os
import re
import threading
from dataclasses import dataclass, field
from pathlib import Path

from .materials import IMAGE_EXTS, _FILENAME_RULES, _tokens, guess_channel_from_filename
from .scene import Material, Scene, TextureRef

MODEL_EXTS = {".fbx", ".obj", ".max"}
MAPS_DIR = re.compile(r"(^|[_\-\s])(maps?|textures?|tex|texturas|images?|bitmaps?)$", re.I)
SKIP_DIRS = re.compile(r"(preview|thumb|thumbnail|document|docs?|render|__macosx|\.git)", re.I)
MAX_INDEX_FILES = 200_000
_RES_TOKEN = re.compile(r"^(\d+k|\d{3,5}(px)?|\d{3,5}x\d{3,5}|lod\d+|v\d+|hi|low|hq|lq)$", re.I)


def _norm(stem: str) -> str:
    toks = [t for t in _tokens(stem) if not _RES_TOKEN.match(t)]
    return "".join(toks)


@dataclass
class LibraryIndex:
    root: Path
    by_name: dict[str, list[str]] = field(default_factory=dict)     # "leaf_01.jpg"
    by_stem: dict[str, list[str]] = field(default_factory=dict)     # "leaf_01"
    by_norm: dict[str, list[str]] = field(default_factory=dict)     # "leaf01"
    images: list[str] = field(default_factory=list)
    models: list[str] = field(default_factory=list)
    maps_dirs: list[str] = field(default_factory=list)

    # ------------------------------------------------------------------ #
    def _prefer(self, cands: list[str], near: str = "") -> str:
        if len(cands) == 1:
            return cands[0]
        near_p = Path(near).parent if near else None

        def score(c: str) -> tuple:
            p = Path(c)
            in_maps = any(MAPS_DIR.search(part) for part in p.parts[-4:-1])
            common = 0
            if near_p is not None:
                try:
                    common = len(os.path.commonpath([str(near_p), str(p.parent)]))
                except ValueError:
                    common = 0
            lossless = p.suffix.lower() in (".png", ".tif", ".tiff", ".tga", ".exr")
            return (in_maps, common, lossless, -len(c))
        return max(cands, key=score)

    def find(self, wanted: str, near: str = "") -> str | None:
        """Best existing file for a (possibly foreign) texture path."""
        base = Path(wanted.replace("\\", "/")).name
        if not base:
            return None
        low = base.lower()
        if low in self.by_name:
            return self._prefer(self.by_name[low], near)
        stem = Path(low).stem
        if stem in self.by_stem:
            return self._prefer(self.by_stem[stem], near)
        n = _norm(stem)
        if n and n in self.by_norm:
            return self._prefer(self.by_norm[n], near)
        return None

    def textures_for_material(self, name: str, hint_paths: list[str] = ()) -> dict[str, TextureRef]:
        """Match a whole PBR set to a material by name (used when it has no maps)."""
        keys = {k for _, ks in _FILENAME_RULES for k in ks}
        generic = {"mat", "mtl", "material", "corona", "vray", "physical", "std", "standard",
                   "default", "mt", "pm", "copy"}
        mt = {t for t in _tokens(name) if t not in generic and t not in keys and not _RES_TOKEN.match(t)}
        if not mt:
            return {}
        best: dict[str, tuple[float, str]] = {}
        for img in self.images:
            st = set(_tokens(Path(img).stem))
            hit = len(mt & st)
            if hit == 0:
                continue
            ch = guess_channel_from_filename(img)
            if ch is None:
                continue
            score = hit / len(mt) + (0.1 if any(MAPS_DIR.search(x) for x in Path(img).parts[-4:-1]) else 0)
            if score < 0.5:
                continue
            if ch not in best or score > best[ch][0]:
                best[ch] = (score, img)
        out: dict[str, TextureRef] = {}
        for ch, (_, img) in best.items():
            if ch == "glossiness":
                if "roughness" not in best:
                    out["roughness"] = TextureRef(img, invert=True)
            else:
                out[ch] = TextureRef(img)
        return out


# --------------------------------------------------------------------------- #
_CACHE: dict[str, tuple[float, LibraryIndex]] = {}
_LOCK = threading.Lock()


def find_library_root(path: str | Path, max_up: int = 4) -> Path:
    """Walk up until a folder that looks like an asset library (has a maps folder)."""
    p = Path(path).resolve()
    start = p if p.is_dir() else p.parent
    cur = start
    best = start
    for _ in range(max_up + 1):
        try:
            kids = [d for d in cur.iterdir() if d.is_dir()]
        except OSError:
            break
        if any(MAPS_DIR.search(d.name) for d in kids):
            best = cur
            # a library folder usually also has model or scene folders: stop here
            if len(kids) >= 2:
                return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return best


def build_index(root: Path, log=None) -> LibraryIndex:
    key = str(root)
    try:
        mtime = root.stat().st_mtime
    except OSError:
        mtime = 0.0
    with _LOCK:
        hit = _CACHE.get(key)
        if hit and hit[0] == mtime:
            return hit[1]
    idx = LibraryIndex(root)
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not SKIP_DIRS.search(d)]
        if MAPS_DIR.search(os.path.basename(dirpath)):
            idx.maps_dirs.append(dirpath)
        for f in filenames:
            ext = os.path.splitext(f)[1].lower()
            full = os.path.join(dirpath, f)
            if ext in IMAGE_EXTS:
                low = f.lower()
                stem = os.path.splitext(low)[0]
                idx.by_name.setdefault(low, []).append(full)
                idx.by_stem.setdefault(stem, []).append(full)
                n = _norm(stem)
                if n:
                    idx.by_norm.setdefault(n, []).append(full)
                idx.images.append(full)
            elif ext in MODEL_EXTS:
                idx.models.append(full)
            count += 1
            if count >= MAX_INDEX_FILES:
                break
        if count >= MAX_INDEX_FILES:
            break
    if log:
        log(f"Indexed {len(idx.images):,} textures in {root.name}")
    with _LOCK:
        _CACHE[key] = (mtime, idx)
    return idx


def relink_scene(scene: Scene, source: str, log=None) -> dict[str, int]:
    """Fix every missing texture of ``scene`` from the library around ``source``."""
    mats = scene.materials()
    missing = [r for m in mats for r in m.maps.values() if not r.exists()]
    empty = [m for m in mats if not m.maps]
    stats = {"relinked": 0, "still_missing": 0, "matched_by_name": 0}
    if not missing and not empty:
        return stats
    root = find_library_root(source)
    idx = build_index(root, log)
    for ref in missing:
        hit = idx.find(ref.path, near=source)
        if hit:
            ref.path = hit
            stats["relinked"] += 1
        else:
            stats["still_missing"] += 1
    for m in empty:
        found = idx.textures_for_material(m.name)
        if found:
            m.maps.update(found)
            m.notes.append("textures matched by name from the library Maps folder")
            stats["matched_by_name"] += 1
    for m in mats:
        _fill_missing_channels(m, idx)
    if stats["relinked"] or stats["matched_by_name"]:
        scene.warnings.append(
            f"Re-linked {stats['relinked']} texture(s) from {root.name}"
            + (f", matched {stats['matched_by_name']} material(s) by name" if stats["matched_by_name"] else ""))
    if stats["still_missing"]:
        scene.warnings.append(f"{stats['still_missing']} texture(s) not found in {root}")
    return stats


def _fill_missing_channels(m: Material, idx: LibraryIndex) -> None:
    """Base colour found but no opacity/normal/roughness: look for siblings of the same set."""
    bc = m.maps.get("base_color")
    if bc is None or not bc.exists():
        return
    folder = Path(bc.path).parent
    stem = Path(bc.path).stem
    keys = {k for _, ks in _FILENAME_RULES for k in ks}
    prefix = "_".join(t for t in _tokens(stem) if t not in keys and not _RES_TOKEN.match(t))
    if not prefix:
        return
    try:
        files = [f for f in folder.iterdir() if f.suffix.lower() in IMAGE_EXTS]
    except OSError:
        return
    for f in files:
        ftoks = "_".join(t for t in _tokens(f.stem) if t not in keys and not _RES_TOKEN.match(t))
        if ftoks != prefix:
            continue
        ch = guess_channel_from_filename(f.name)
        if ch is None or ch == "base_color" or ch == "displacement":
            continue
        if ch == "glossiness":
            if "roughness" not in m.maps:
                m.maps["roughness"] = TextureRef(str(f), invert=True)
            continue
        if ch not in m.maps:
            m.maps[ch] = TextureRef(str(f))


def find_models_for_max(max_file: str) -> list[str]:
    """FBX/OBJ exports that ship with a .max in the same library (no 3ds Max needed)."""
    p = Path(max_file)
    root = find_library_root(p)
    idx = build_index(root)
    models = [m for m in idx.models if Path(m).suffix.lower() in (".fbx", ".obj")]
    if not models:
        return []
    stem = p.stem.lower()
    exact = [m for m in models if Path(m).stem.lower() == stem]
    if exact:
        return sorted(exact, key=lambda m: Path(m).suffix.lower() != ".fbx")[:1]
    n = _norm(re.sub(r"(corona|vray|v-ray|scene|max\d*|\d{4})", "", stem, flags=re.I))
    close = [m for m in models if n and _norm(Path(m).stem) == n]
    if close:
        return close[:1]
    # A collection scene (all trees in one .max): use every model export, FBX first
    fbx = [m for m in models if m.lower().endswith(".fbx")]
    chosen = fbx or models
    # one file per model name (skip OBJ twins of FBX files)
    seen: dict[str, str] = {}
    for m in sorted(chosen):
        seen.setdefault(Path(m).stem.lower(), m)
    return list(seen.values())
