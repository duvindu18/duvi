"""Export pipeline: selection -> optimised FBX + D5-ready textures + report."""
from __future__ import annotations

import copy
import json
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from .fbx.writer import FBXWriteOptions, write_fbx
from .optimize.mesh import MeshReport, optimize_nodes
from .optimize.textures import (D5_SUFFIX, TextureJob, TextureOptions, TextureResult,
                                run_jobs, safe_stem)
from .scene import Material, Node, Scene, Variant, translation_matrix


@dataclass
class ExportOptions:
    out_dir: str = ""
    asset_name: str = ""
    split_variants: bool = True          # one FBX per variant
    center_to_origin: bool = True        # base of each variant at (0,0,0)
    shared_textures: bool = True         # variants share one textures/ folder
    optimize_meshes: bool = True
    instancing: bool = True
    embed_textures: bool = False         # D5 reads external textures fine
    include_hidden: bool = True
    textures: TextureOptions = field(default_factory=TextureOptions)

    def to_json(self) -> dict:
        d = asdict(self)
        return d

    @staticmethod
    def from_json(d: dict) -> "ExportOptions":
        o = ExportOptions()
        for k, v in d.items():
            if k == "textures" and isinstance(v, dict):
                for tk, tv in v.items():
                    if hasattr(o.textures, tk):
                        setattr(o.textures, tk, tv)
            elif hasattr(o, k):
                setattr(o, k, v)
        return o


@dataclass
class ExportResult:
    files: list[str] = field(default_factory=list)
    texture_results: list[TextureResult] = field(default_factory=list)
    mesh_report: MeshReport = field(default_factory=MeshReport)
    bytes_source: int = 0
    bytes_output: int = 0
    warnings: list[str] = field(default_factory=list)
    seconds: float = 0.0
    report_path: str = ""


class Cancelled(Exception):
    pass


# --------------------------------------------------------------------------- #
def extract_selection(roots: list[Node], selected: set[int] | None,
                      include_hidden: bool) -> list[Node]:
    """Copy the sub-trees under ``roots`` keeping only selected mesh nodes.

    Meshes and materials are shared with the source scene here; the pipeline
    deep-copies them before anything is modified.
    """
    def keep(n: Node) -> bool:
        if n.mesh is None:
            return False
        if not include_hidden and not n.visible:
            return False
        return selected is None or id(n) in selected

    def clone(n: Node, world: bool) -> Node | None:
        kids = [c for c in (clone(c, False) for c in n.children) if c is not None]
        if not keep(n) and not kids:
            return None
        out = Node(n.name, (n.world_matrix() if world else n.local_matrix).copy(),
                   n.mesh if keep(n) else None, list(n.materials) if keep(n) else [],
                   layer=n.layer, visible=True, uid=n.uid, tags=dict(n.tags))
        for k in kids:
            out.add(k)
        return out

    out = []
    for r in roots:
        c = clone(r, True)
        if c is not None:
            out.append(c)
    return out


def _isolate(roots: list[Node]) -> list[Node]:
    """Deep-copy meshes and materials so optimisation never touches the source."""
    mesh_map: dict[int, object] = {}
    mat_map: dict[int, Material] = {}
    for r in roots:
        for n in r.walk():
            if n.mesh is not None:
                k = id(n.mesh)
                if k not in mesh_map:
                    mesh_map[k] = n.mesh.copy()
                n.mesh = mesh_map[k]  # type: ignore[assignment]
            new = []
            for m in n.materials:
                if id(m) not in mat_map:
                    mat_map[id(m)] = copy.deepcopy(m)
                new.append(mat_map[id(m)])
            n.materials = new
    return roots


def _bounds(roots: list[Node]) -> tuple[np.ndarray, np.ndarray]:
    tmp = Scene()
    nodes = [n for r in roots for n in r.walk() if n.mesh is not None]
    return tmp.world_bounds(nodes)


def _center(roots: list[Node], up_axis: str) -> None:
    lo, hi = _bounds(roots)
    c = (lo + hi) / 2
    up = 2 if up_axis == "Z" else 1
    c[up] = lo[up]
    t = translation_matrix(-c)
    for r in roots:
        r.local_matrix = t @ r.local_matrix


def _unique_material_names(mats: list[Material]) -> None:
    used: dict[str, int] = {}
    for m in mats:
        base = safe_stem(m.name)
        name = base
        while name.lower() in used:
            used[base.lower()] = used.get(base.lower(), 1) + 1
            name = f"{base}_{used[base.lower()]}"
        used[name.lower()] = 1
        m.name = name


def build_texture_jobs(mats: list[Material], opts: TextureOptions) -> dict[int, dict[str, TextureJob]]:
    jobs: dict[int, dict[str, TextureJob]] = {}
    for m in mats:
        mj: dict[str, TextureJob] = {}
        stem = safe_stem(m.name)
        for ch, ref in m.maps.items():
            if ch not in D5_SUFFIX or not ref.path:
                continue
            j = TextureJob(ch, ref.path, f"{stem}_{D5_SUFFIX[ch]}")
            j.extract = ref.channel if ref.channel in ("R", "G", "B", "A") else ""
            if ch == "roughness" and ref.invert and opts.convert_gloss_to_roughness:
                j.invert = True
            elif ref.invert and ch != "roughness":
                j.invert = True
            if ch == "normal" and m.normal_convention != opts.normal_target:
                j.flip_green = True
            mj[ch] = j
        op = m.maps.get("opacity")
        bc = mj.get("base_color")
        if bc is not None and op is not None and opts.pack_opacity_in_base_alpha:
            bc.alpha_from = op.path
            bc.alpha_extract = op.channel if op.channel in ("R", "G", "B", "A") else ""
            bc.alpha_invert = op.invert
        jobs[id(m)] = mj
    return jobs


def _apply_constant(m: Material, ch: str, value: tuple[float, ...]) -> None:
    v = list(value)
    grey = float(np.mean(v[:3])) if len(v) >= 3 else float(v[0])
    rgb = tuple(v[:3]) if len(v) >= 3 else (v[0], v[0], v[0])
    if ch == "base_color":
        m.base_color = rgb  # type: ignore[assignment]
        if len(v) in (2, 4) and v[-1] < 1.0:
            m.opacity = float(v[-1])
    elif ch == "roughness":
        m.roughness = grey
    elif ch == "metallic":
        m.metallic = grey
    elif ch == "opacity":
        m.opacity = grey
    elif ch == "emissive":
        m.emissive = rgb  # type: ignore[assignment]
    elif ch == "translucency":
        m.translucency = rgb  # type: ignore[assignment]
    # constant normal/bump/AO maps carry no detail: just dropped
    m.maps.pop(ch, None)


def _source_bytes(scene: Scene, mats: list[Material]) -> int:
    total = 0
    src = scene.source_path
    if src and os.path.isfile(src):
        total += os.path.getsize(src)
    seen = set()
    for m in mats:
        for ref in m.maps.values():
            if ref.path not in seen and os.path.isfile(ref.path):
                seen.add(ref.path)
                total += os.path.getsize(ref.path)
    return total


# --------------------------------------------------------------------------- #
def export(scene: Scene, variants: list[Variant], selected: set[int] | None,
           opts: ExportOptions, progress=None, cancel=lambda: False) -> ExportResult:
    """Export the chosen variants (optionally only ``selected`` node ids)."""
    t0 = time.time()
    res = ExportResult()

    def report(msg: str, frac: float) -> None:
        if progress:
            progress(msg, frac)
        if cancel():
            raise Cancelled()

    asset = safe_stem(opts.asset_name or Path(scene.source_path or "model").stem)
    out_root = Path(opts.out_dir) / asset
    out_root.mkdir(parents=True, exist_ok=True)

    # ---- what to write ------------------------------------------------- #
    units: list[tuple[str, list[Node]]] = []
    if opts.split_variants and len(variants) > 1:
        for v in variants:
            roots = extract_selection(v.nodes, selected, opts.include_hidden)
            if roots:
                units.append((safe_stem(v.name), roots))
    else:
        roots = extract_selection([n for v in variants for n in v.nodes] or scene.root.children,
                                  selected, opts.include_hidden)
        if roots:
            units.append((asset, roots))
    if not units:
        raise ValueError("Nothing selected to export")

    _isolate([r for _, rs in units for r in rs])
    all_mats: dict[int, Material] = {}
    for _, rs in units:
        for r in rs:
            for n in r.walk():
                for m in n.materials:
                    all_mats.setdefault(id(m), m)
    mats = list(all_mats.values())
    res.bytes_source = _source_bytes(scene, mats)
    _unique_material_names(mats)

    # ---- meshes -------------------------------------------------------- #
    report("Optimising meshes (lossless)", 0.05)
    for _, rs in units:
        nodes = [n for r in rs for n in r.walk()]
        if opts.optimize_meshes:
            res.mesh_report.merge(optimize_nodes(nodes, instancing=opts.instancing))
        if opts.center_to_origin:
            _center(rs, scene.up_axis)

    # ---- textures ------------------------------------------------------ #
    tex_dir = out_root / "textures"
    jobs = build_texture_jobs(mats, opts.textures)
    flat = [j for mj in jobs.values() for j in mj.values()]

    def tprog(done: int, total: int, name: str) -> None:
        report(f"Textures {done}/{total}: {Path(name).name}", 0.1 + 0.75 * done / max(total, 1))

    results = run_jobs(flat, tex_dir, opts.textures, tprog)
    res.texture_results = results
    by_job = {id(r.job): r for r in results}
    tex_paths: dict[int, dict[str, str]] = {}
    base_alpha: set[int] = set()
    for m in mats:
        out: dict[str, str] = {}
        for ch, j in jobs.get(id(m), {}).items():
            r = by_job[id(j)]
            if r.error and not r.output:
                res.warnings.append(f"{m.name}/{ch}: {r.error}")
                m.maps.pop(ch, None)
                continue
            if r.constant is not None:
                _apply_constant(m, ch, r.constant)
                continue
            out[ch] = r.output
            if ch == "base_color" and j.alpha_from and not any("could not pack" in x for x in r.notes):
                from PIL import Image
                try:
                    with Image.open(r.output) as im:
                        if im.mode in ("RGBA", "LA"):
                            base_alpha.add(id(m))
                except OSError:
                    pass
        tex_paths[id(m)] = out

    # ---- FBX ------------------------------------------------------------ #
    fopts = FBXWriteOptions(embed_media=opts.embed_textures, instancing=opts.instancing)
    for i, (name, rs) in enumerate(units):
        report(f"Writing {name}.fbx", 0.86 + 0.12 * i / len(units))
        fbx_path = out_root / f"{name}.fbx"
        write_fbx(str(fbx_path), scene, rs, tex_paths, fopts, base_alpha)
        res.files.append(str(fbx_path))
        res.bytes_output += fbx_path.stat().st_size

    written = {r.output for r in results if r.output and not r.shared_with}
    res.bytes_output += sum(os.path.getsize(p) for p in written if os.path.isfile(p))

    # ---- sidecar for D5: what goes where -------------------------------- #
    side = {
        "generator": "D5 Bridge",
        "source": scene.source_path,
        "files": [Path(f).name for f in res.files],
        "materials": [{
            "name": m.name,
            "template_hint": "Foliage" if m.is_foliage else "Custom",
            "two_sided": m.two_sided,
            "base_color": m.base_color, "roughness": m.roughness, "metallic": m.metallic,
            "opacity": m.opacity, "normal_strength": m.normal_strength,
            "textures": {ch: os.path.relpath(p, out_root) for ch, p in tex_paths.get(id(m), {}).items()},
            "notes": m.notes,
        } for m in mats],
    }
    (out_root / "d5_materials.json").write_text(json.dumps(side, indent=1), encoding="utf-8")
    res.warnings.extend(scene.warnings)
    res.seconds = time.time() - t0
    res.report_path = str(out_root / "export_report.txt")
    Path(res.report_path).write_text(format_report(res, mats, tex_paths, out_root), encoding="utf-8")
    report("Done", 1.0)
    return res


def _mb(n: int) -> str:
    return f"{n / 1048576:.1f} MB"


def format_report(res: ExportResult, mats: list[Material], tex_paths: dict, out_root: Path) -> str:
    lines = ["D5 Bridge export report", "=" * 24, ""]
    lines.append(f"Output folder : {out_root}")
    for f in res.files:
        lines.append(f"  FBX         : {Path(f).name}  ({_mb(os.path.getsize(f))})")
    lines.append(f"Source size   : {_mb(res.bytes_source)} (model + textures it uses)")
    lines.append(f"Output size   : {_mb(res.bytes_output)}")
    mr = res.mesh_report
    lines += ["", "Geometry (lossless)",
              f"  control points {mr.vertices_before:,} -> {mr.vertices_after:,}",
              f"  normals        {mr.normals_before:,} -> {mr.normals_after:,} unique",
              f"  UVs            {mr.uvs_before:,} -> {mr.uvs_after:,} unique",
              f"  degenerate faces removed: {mr.faces_removed:,}",
              f"  objects turned into instances: {mr.instanced:,}"]
    lines += mr.notes[:20]
    lines += ["", "Textures (full resolution kept)"]
    for r in res.texture_results:
        if r.shared_with:
            lines.append(f"  {r.job.out_stem}: same image as {r.shared_with}")
            continue
        if r.constant is not None:
            lines.append(f"  {r.job.out_stem}: single colour -> material value {tuple(round(x, 3) for x in r.constant)}")
            continue
        if r.error and not r.output:
            lines.append(f"  {r.job.out_stem}: ERROR {r.error}")
            continue
        lines.append(f"  {Path(r.output).name}: {r.width}x{r.height}  {_mb(r.bytes_in)} -> {_mb(r.bytes_out)}"
                     + (f"  ({'; '.join(r.notes)})" if r.notes else ""))
    lines += ["", "Materials"]
    for m in mats:
        chans = ", ".join(sorted(tex_paths.get(id(m), {}).keys())) or "constant"
        lines.append(f"  {m.name}: {chans}" + ("  [foliage, two-sided]" if m.is_foliage else ""))
        for n in m.notes:
            lines.append(f"      - {n}")
    if res.warnings:
        lines += ["", "Warnings"] + [f"  ! {w}" for w in res.warnings]
    lines += ["", "In D5 Render", "  Import the .fbx. For leaf materials pick the Foliage template if",
              "  D5 did not choose it: the opacity is in the base-colour alpha and in the",
              "  *_Opacity map. Roughness / Metallic / AO / Translucency maps are in",
              "  textures/ with D5 suffixes (see d5_materials.json) for manual slots.", ""]
    return "\n".join(lines)
