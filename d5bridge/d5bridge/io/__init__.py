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
            models = sorted([*p.glob("*.fbx"), *p.glob("*.obj"), *p.glob("*.max")])
            if not models:
                raise ValueError(f"No .max, .fbx or .obj file in {p}")
            return load_any(str(models[0]), log, max_options, lod)
    else:
        ext = p.suffix.lower()
        if ext == ".max":
            from ..max.bridge import convert_max_file
            from .max_bundle import load_bundle
            bundle = convert_max_file(str(p), options=max_options, log=log)
            scene = load_bundle(str(bundle))
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
    for m in scene.materials():
        finalize_material(m)
    if not scene.variants:
        scene.variants = detect_variants(scene)
    return scene
