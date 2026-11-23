"""Load a bundle written by the 3ds Max exporter (scene.fbx + manifest.json)."""
from __future__ import annotations

import json
import os
from pathlib import Path

from ..fbx.reader import read_fbx
from ..materials import finalize_material, guess_channel_from_filename, _tokens
from ..scene import Material, Node, Scene, TextureRef, Variant


def is_bundle(path: str) -> bool:
    p = Path(path)
    if p.is_dir():
        return (p / "manifest.json").is_file()
    return p.name == "manifest.json"


def _resolve(path: str, search_dirs: list[Path], assets_by_name: dict[str, str]) -> str:
    if not path:
        return ""
    if os.path.isfile(path):
        return path
    base = Path(path.replace("\\", "/")).name
    hit = assets_by_name.get(base.lower())
    if hit and os.path.isfile(hit):
        return hit
    for d in search_dirs:
        for sub in ("", "maps", "Maps", "textures", "Textures", "tex"):
            c = d / sub / base
            if c.is_file():
                return str(c)
    return path


def material_from_manifest(md: dict, resolve) -> Material:
    m = Material(name=md.get("name", "material"), source_type=md.get("source_type", ""))
    m.base_color = tuple(md.get("base_color", (0.8, 0.8, 0.8)))[:3]  # type: ignore[assignment]
    m.opacity = float(md.get("opacity", 1.0))
    m.roughness = float(min(max(md.get("roughness", 0.5), 0.0), 1.0))
    m.metallic = float(min(max(md.get("metallic", 0.0), 0.0), 1.0))
    m.normal_strength = float(md.get("normal_strength", 1.0))
    m.bump_strength = float(md.get("bump_strength", 1.0))
    m.emissive = tuple(md.get("emissive", (0, 0, 0)))[:3]  # type: ignore[assignment]
    m.translucency = tuple(md.get("translucency", (0, 0, 0)))[:3]  # type: ignore[assignment]
    m.two_sided = bool(md.get("two_sided", False))
    m.is_foliage = bool(md.get("is_foliage", False))
    m.notes = list(md.get("notes", []))
    m.normal_convention = "directx"       # 3ds Max convention
    for ch, d in (md.get("maps") or {}).items():
        if not isinstance(d, dict) or not d.get("path"):
            continue
        ref = TextureRef(
            path=resolve(d["path"]),
            uv_scale=tuple(d.get("uv_scale", (1.0, 1.0)))[:2],  # type: ignore[arg-type]
            uv_offset=tuple(d.get("uv_offset", (0.0, 0.0)))[:2],  # type: ignore[arg-type]
            invert=bool(d.get("invert", False)),
            channel=str(d.get("channel", "")),
        )
        if d.get("map_channel", 1) not in (1, None):
            ref.uv_set = f"UVChannel_{int(d['map_channel'])}"
        if ch == "normal" and d.get("flip_green"):
            m.normal_convention = "opengl"   # Max flipped it for display, D5 needs it flipped too
        if d.get("baked"):
            m.notes.append(f"{ch}: baked from {d.get('source_class', 'procedural map')}")
        m.maps[ch] = ref
    return m


def guess_by_name(mat_name: str, assets: list[str]) -> dict[str, TextureRef]:
    """When the renderer plug-in is missing: match bitmaps to a material by name."""
    mt = set(_tokens(mat_name)) - {"mat", "mtl", "material", "corona", "vray", "01", "1"}
    best: dict[str, tuple[int, str]] = {}
    for a in assets:
        ch = guess_channel_from_filename(a)
        if not ch:
            continue
        score = len(mt & set(_tokens(Path(a).stem)))
        if score == 0:
            continue
        if ch not in best or score > best[ch][0]:
            best[ch] = (score, a)
    out = {}
    for ch, (_, a) in best.items():
        if ch == "glossiness":
            out["roughness"] = TextureRef(a, invert=True)
        else:
            out[ch] = TextureRef(a)
    return out


def load_bundle(path: str) -> Scene:
    p = Path(path)
    folder = p if p.is_dir() else p.parent
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    err = folder / "error.txt"
    fbx = folder / manifest.get("fbx", "scene.fbx")
    if not fbx.is_file():
        raise FileNotFoundError(f"3ds Max did not write {fbx.name}"
                                + (f":\n{err.read_text()}" if err.is_file() else ""))
    scene = read_fbx(str(fbx))
    scene.source_kind = "max-bundle"
    scene.source_path = manifest.get("max_file") or str(fbx)
    scene.warnings.extend(manifest.get("warnings", []))

    max_dir = Path(manifest.get("max_file", "")).parent if manifest.get("max_file") else folder
    assets = manifest.get("scene_assets", [])
    assets_by_name = {Path(a.replace("\\", "/")).name.lower(): a for a in assets}
    search = [folder, max_dir, max_dir.parent]

    def resolve(x: str) -> str:
        return _resolve(x, search, assets_by_name)

    resolved_assets = [resolve(a) for a in assets]
    mats: dict[str, Material] = {}
    for name, md in (manifest.get("materials") or {}).items():
        m = material_from_manifest(md, resolve)
        if md.get("missing_plugin") or (not m.maps and resolved_assets):
            for ch, ref in guess_by_name(name, resolved_assets).items():
                m.maps.setdefault(ch, ref)
            if m.maps:
                m.notes.append("textures matched by file name (renderer plug-in unavailable)")
        mats[name] = finalize_material(m)

    info = {n["name"]: n for n in manifest.get("nodes", [])}
    missing_tex: set[str] = set()
    for node in scene.nodes():
        ni = info.get(node.name)
        if ni:
            node.layer = ni.get("layer", "")
            node.tags["max_class"] = ni.get("class", "")
            if ni.get("hidden"):
                node.tags["hidden_in_max"] = "1"
        node.materials = [mats.get(m.name, m) for m in node.materials]
        for m in node.materials:
            for ref in m.maps.values():
                if not ref.exists():
                    missing_tex.add(ref.path)
    if missing_tex:
        scene.warnings.append(f"{len(missing_tex)} texture file(s) not found: "
                              + ", ".join(sorted(Path(x).name for x in missing_tex)[:8]))

    scene.variants = variants_from_hints(scene, manifest)
    thumbs = manifest.get("thumbnails") or {}
    for v in scene.variants:
        if v.name in thumbs:
            v.reason += f"|thumb={thumbs[v.name]}"
    return scene


def variants_from_hints(scene: Scene, manifest: dict) -> list[Variant]:
    by_name: dict[str, Node] = {n.name: n for n in scene.nodes()}

    def build(groups: dict[str, list[str]], reason: str) -> list[Variant]:
        out = []
        for gname, members in groups.items():
            roots = []
            if gname in by_name:
                roots = [by_name[gname]]
            else:
                roots = [by_name[m] for m in members if m in by_name]
                # keep only top-most of the members
                ids = {id(r) for r in roots}
                roots = [r for r in roots if not _has_ancestor_in(r, ids)]
            if roots:
                out.append(Variant(gname, roots, reason=reason))
        return out

    picked = manifest.get("picked_variants")
    if picked:
        vs = build({p["name"]: p["nodes"] for p in picked}, "picked in 3ds Max")
        if vs:
            return vs
    hints = manifest.get("variant_hints") or {}
    groups = hints.get("groups") or {}
    if len(groups) >= 2:
        return build(groups, "3ds Max group")
    layers = {k: v for k, v in (hints.get("layers") or {}).items() if k not in ("0", "")}
    if len(layers) >= 2:
        return build(layers, "3ds Max layer")
    sets = hints.get("selection_sets") or {}
    if len(sets) >= 2:
        return build(sets, "3ds Max selection set")
    return []  # fall back to automatic detection


def _has_ancestor_in(n: Node, ids: set[int]) -> bool:
    p = n.parent
    while p is not None:
        if id(p) in ids:
            return True
        p = p.parent
    return False
