"""Format dispatch: open anything D5 Bridge understands."""
from __future__ import annotations

from pathlib import Path

from ..scene import Scene

SUPPORTED = (".max", ".fbx", ".obj", ".json")


def load_any(path: str, log=print, max_options: dict | None = None, lod: int = 0) -> Scene:
    from ..materials import finalize_material
    from ..variants import detect_variants

    p = Path(path)
    if p.is_dir():
        from .max_bundle import is_bundle, load_bundle
        from .megascans import is_megascans_folder, load_megascans
        if is_bundle(str(p)):
            scene = load_bundle(str(p))
        elif is_megascans_folder(p):
            scene = load_megascans(str(p), lod=lod)
        else:
            return load_folder(p, log, max_options, lod)
    else:
        ext = p.suffix.lower()
        if ext == ".max":
            scene = load_max(p, log, max_options, lod)
        elif p.name == "manifest.json":
            from .max_bundle import load_bundle
            scene = load_bundle(str(p.parent))
        elif ext == ".json":
            from .megascans import load_megascans
            scene = load_megascans(str(p.parent), lod=lod)
        elif ext == ".fbx":
            from ..fbx.reader import read_fbx
            from .megascans import is_megascans_folder, collect_folder_textures, _fill_material
            scene = read_fbx(str(p))
            if is_megascans_folder(p.parent):
                tex = collect_folder_textures(p.parent)
                for n in scene.mesh_nodes():
                    for m in n.materials:
                        _fill_material(m, tex, "opengl")
        elif ext == ".obj":
            from .obj_reader import read_obj
            scene = read_obj(str(p))
        else:
            raise ValueError(f"Unsupported file type: {ext}")
    from ..library import relink_scene
    relink_scene(scene, str(p), log=log)
    for m in scene.materials():
        finalize_material(m)
    if not scene.variants:
        scene.variants = detect_variants(scene)
    return scene


def load_max(p: Path, log=print, max_options: dict | None = None, lod: int = 0) -> Scene:
    """Open a .max: through 3ds Max when installed, otherwise from the FBX/OBJ
    exports that ship next to it in the library (MaxTree, Evermotion...)."""
    from ..library import find_models_for_max
    from ..max.bridge import convert_max_file, find_max_installs
    from .max_bundle import load_bundle

    use_max = (max_options or {}).get("use_3dsmax", True)
    if use_max and find_max_installs():
        bundle = convert_max_file(str(p), options=max_options, log=log)
        return load_bundle(str(bundle))
    models = find_models_for_max(str(p))
    if not models:
        raise RuntimeError(
            f"{p.name}: 3ds Max is not installed and no FBX/OBJ export of this model was found "
            "in its library folder. A .max file can only be read by 3ds Max itself; most "
            "libraries (MaxTree, Evermotion) include an FBX folder - open that, or install "
            "3ds Max 2021+.")
    log(f"3ds Max not installed: using {len(models)} FBX/OBJ export(s) from the library")
    scene = load_many(models, log, lod)
    scene.source_path = str(p)
    scene.warnings.insert(0, f"Opened without 3ds Max: geometry and textures come from the "
                             f"library's own export ({', '.join(Path(m).name for m in models[:4])}"
                             f"{'...' if len(models) > 4 else ''}).")
    return scene


def load_many(paths: list[str], log=print, lod: int = 0) -> Scene:
    """Several model files -> one scene; each file's variants become variants."""
    from ..library import relink_scene
    from ..materials import finalize_material
    from ..scene import Node, Variant
    from ..variants import detect_variants
    if len(paths) == 1:
        return load_any(paths[0], log=log, lod=lod)
    out = Scene(source_kind="library")
    for i, path in enumerate(paths):
        log(f"Loading {Path(path).name} ({i + 1}/{len(paths)})")
        sub = _load_single(Path(path), lod)
        relink_scene(sub, path, log=None)
        for m in sub.materials():
            finalize_material(m)
        if i == 0:
            out.unit_scale_cm, out.up_axis = sub.unit_scale_cm, sub.up_axis
        elif sub.up_axis != out.up_axis:
            out.warnings.append(f"{Path(path).name} uses a different up axis")
        vs = sub.variants or detect_variants(sub)
        group = Node(Path(path).stem)
        group.tags["source_file"] = path
        for c in list(sub.root.children):
            group.add(c)
        out.root.add(group)
        stem = Path(path).stem
        if len(vs) <= 1:
            out.variants.append(Variant(stem, [group], reason=f"file {Path(path).name}"))
        else:
            for v in vs:
                out.variants.append(Variant(f"{stem} / {v.name}", v.nodes, reason=f"{v.reason} in {Path(path).name}"))
        out.warnings.extend(sub.warnings)
    return out


def _load_single(p: Path, lod: int) -> Scene:
    ext = p.suffix.lower()
    if ext == ".fbx":
        from ..fbx.reader import read_fbx
        from ..variants import detect_variants
        s = read_fbx(str(p))
        s.variants = detect_variants(s)
        return s
    if ext == ".obj":
        from .obj_reader import read_obj
        from ..variants import detect_variants
        s = read_obj(str(p))
        s.variants = detect_variants(s)
        return s
    return load_any(str(p), lod=lod)


def load_folder(p: Path, log=print, max_options: dict | None = None, lod: int = 0) -> Scene:
    """A library or model folder: every FBX/OBJ model in it (one variant each)."""
    import os
    from ..library import SKIP_DIRS
    models: list[str] = []
    maxes: list[str] = []
    base_depth = str(p).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(p):
        dirnames[:] = [d for d in dirnames if not SKIP_DIRS.search(d)]
        if dirpath.count(os.sep) - base_depth > 3:
            dirnames[:] = []
        for f in filenames:
            e = os.path.splitext(f)[1].lower()
            if e in (".fbx", ".obj"):
                models.append(os.path.join(dirpath, f))
            elif e == ".max":
                maxes.append(os.path.join(dirpath, f))
    # an OBJ next to an FBX of the same name is the same model
    by_stem: dict[str, str] = {}
    for m in sorted(models, key=lambda x: (not x.lower().endswith(".fbx"), x)):
        by_stem.setdefault(Path(m).stem.lower(), m)
    models = sorted(by_stem.values())
    if models:
        scene = load_many(models, log, lod)
        if len(models) > 1:
            scene.source_path = str(p)
            from ..library import relink_scene
            relink_scene(scene, str(p), log=log)
        return scene
    if maxes:
        return load_any(sorted(maxes)[0], log, max_options, lod)
    raise ValueError(f"No .max, .fbx or .obj file in {p}")
