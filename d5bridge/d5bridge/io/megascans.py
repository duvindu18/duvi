"""Quixel Megascans / Fab asset folders -> one Scene with a Variant per model.

Handles the layouts Bridge and Fab produce:

  3D asset   : <id>_LOD0.fbx + <id>_4K_Albedo.jpg, _Normal, _Roughness ...
  3D plant   : Var1/Var1_LOD0.fbx, Var2/... + Textures/Atlas/*, Textures/Billboard/*
  Fab export : <name>/<name>_LOD0.fbx + Textures/<name>_BaseColor.png ...
"""
from __future__ import annotations

import json
import re
from pathlib import Path

from ..materials import IMAGE_EXTS, collect_textures_for_stem, finalize_material
from ..scene import Material, Node, Scene, TextureRef, Variant

MODEL_EXTS = (".fbx", ".obj")
_LOD = re.compile(r"lod[_-]?(\d+)", re.I)
_VAR = re.compile(r"var(?:iation)?[_-]?(\d+)", re.I)


def is_megascans_folder(folder: Path) -> bool:
    if not folder.is_dir():
        return False
    for f in folder.glob("*.json"):
        try:
            data = json.loads(f.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and ("meta" in data or "semanticTags" in data or "id" in data
                                       and ("maps" in data or "components" in data)):
            return True
    names = [p.name.lower() for p in folder.rglob("*")][:500]
    return any("_lod0" in n for n in names) and any("albedo" in n or "basecolor" in n for n in names)


def _lod_of(p: Path) -> int:
    m = _LOD.search(p.stem)
    return int(m.group(1)) if m else 0


def _variant_of(p: Path, root: Path) -> str:
    rel = p.relative_to(root)
    for part in list(rel.parts[:-1]) + [p.stem]:
        m = _VAR.search(part)
        if m:
            return f"Var{int(m.group(1))}"
    return re.sub(r"[_-]?lod[_-]?\d+$", "", p.stem, flags=re.I) or p.stem


def find_models(folder: Path, lod: int = 0) -> dict[str, Path]:
    """variant name -> model file at the requested LOD (or the closest one)."""
    cands: dict[str, list[Path]] = {}
    for p in folder.rglob("*"):
        if p.suffix.lower() not in MODEL_EXTS or not p.is_file():
            continue
        low = str(p).lower()
        if "billboard" in low or "collision" in low or "_ucx" in low:
            continue
        cands.setdefault(_variant_of(p, folder), []).append(p)
    out: dict[str, Path] = {}
    for var, files in cands.items():
        # prefer FBX, then the requested LOD
        files.sort(key=lambda f: (abs(_lod_of(f) - lod), f.suffix.lower() != ".fbx", len(str(f))))
        out[var] = files[0]
    return dict(sorted(out.items(), key=lambda kv: _natural(kv[0])))


def _natural(s: str) -> list:
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def collect_folder_textures(folder: Path) -> dict[str, TextureRef]:
    """Merge texture sets from the asset folder and its Textures/Atlas folders."""
    found: dict[str, TextureRef] = {}
    dirs = [folder] + [d for d in folder.rglob("*") if d.is_dir()
                       and "billboard" not in str(d).lower() and "preview" not in d.name.lower()]
    for d in dirs:
        if not any(f.suffix.lower() in IMAGE_EXTS for f in d.iterdir() if f.is_file()):
            continue
        for ch, ref in collect_textures_for_stem(d).items():
            found.setdefault(ch, ref)
    return found


def set_prefix(path: str) -> str:
    """'abc_4K_Albedo' -> 'abc': the name shared by all maps of one texture set."""
    from ..materials import _FILENAME_RULES, _tokens
    keys = {k for _, ks in _FILENAME_RULES for k in ks}
    toks = [t for t in _tokens(Path(path).stem)
            if t not in keys and not re.fullmatch(r"\d+k|lod\d+|dx|gl|directx|opengl", t)]
    return "_".join(toks)


def _normal_convention(path: str, default: str) -> str:
    s = Path(path).stem.lower()
    if "dx" in re.split(r"[_\-\s]", s) or s.endswith("normaldx") or "directx" in s:
        return "directx"
    if "gl" in re.split(r"[_\-\s]", s) or s.endswith("normalgl") or "opengl" in s:
        return "opengl"
    return default


def load_megascans(folder: str, lod: int = 0, normal_default: str = "opengl") -> Scene:
    from . import load_any

    root = Path(folder)
    scene = Scene(source_path=str(root), source_kind="megascans")
    models = find_models(root, lod)
    if not models:
        scene.warnings.append("No FBX/OBJ model found in the Megascans folder")
        return scene
    textures = collect_folder_textures(root)

    for var, path in models.items():
        sub = load_any(str(path))
        scene.unit_scale_cm = sub.unit_scale_cm
        scene.up_axis = sub.up_axis
        scene.warnings.extend(sub.warnings)
        group = Node(var)
        group.tags["source_file"] = str(path)
        for child in list(sub.root.children):
            group.add(child)
        scene.root.add(group)
        scene.variants.append(Variant(var, [group], reason=f"Megascans {path.name}"))

    # Assign folder textures to materials that came without (or with broken) maps
    var_tex: dict[str, dict[str, TextureRef]] = {}
    for var, path in models.items():
        local = collect_textures_for_stem(path.parent)
        var_tex[var] = {**textures, **local}

    for v in scene.variants:
        tex = var_tex.get(v.name, textures)
        for n in v.mesh_nodes():
            for m in n.materials:
                _fill_material(m, tex, normal_default)
    return scene


def _fill_material(m: Material, tex: dict[str, TextureRef], normal_default: str) -> None:
    base = m.maps.get("base_color")
    prefix = set_prefix(base.path) if base is not None and base.exists() else None
    for ch, ref in tex.items():
        if ch == "displacement":
            continue               # D5 does not use displacement from FBX
        if prefix is not None and set_prefix(ref.path) != prefix:
            continue               # belongs to another material's texture set
        cur = m.maps.get(ch)
        if cur is None or not cur.exists():
            m.maps[ch] = TextureRef(ref.path, invert=ref.invert)
    if "normal" in m.maps:
        m.normal_convention = _normal_convention(m.maps["normal"].path, normal_default)
    finalize_material(m)
