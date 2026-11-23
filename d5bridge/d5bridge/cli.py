"""Command line: batch conversion without the UI.

    D5Bridge.exe --export tree.max --out D:\\D5\\assets --split-variants
    D5Bridge.exe --export "C:\\Megascans\\plant_folder" --out D:\\D5 --variants Var1,Var3
    D5Bridge.exe --info model.fbx
"""
from __future__ import annotations

import argparse
import json
import sys

from .io import load_any
from .pipeline import ExportOptions, export
from .settings import load_settings


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="D5Bridge", description="3ds Max / Megascans -> FBX for D5 Render")
    p.add_argument("input", nargs="?", help="file or folder to open in the app")
    p.add_argument("--export", metavar="PATH", help="convert PATH without opening the UI")
    p.add_argument("--info", metavar="PATH", help="print objects, variants and materials")
    p.add_argument("--out", help="output folder (default: last used)")
    p.add_argument("--variants", help="comma separated variant names (default: all)")
    p.add_argument("--split-variants", action="store_true", help="one FBX per variant")
    p.add_argument("--single-file", action="store_true", help="everything in one FBX")
    p.add_argument("--mode", choices=["lossless", "visually_lossless", "copy"], help="texture mode")
    p.add_argument("--embed", action="store_true", help="embed textures in the FBX")
    p.add_argument("--no-center", action="store_true", help="keep original positions")
    p.add_argument("--lod", type=int, default=0, help="Megascans LOD to use (default 0)")
    return p


def run_cli(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    if args.info:
        scene = load_any(args.info, lod=args.lod)
        print(json.dumps({
            "stats": scene.stats(),
            "up_axis": scene.up_axis, "unit_scale_cm": scene.unit_scale_cm,
            "variants": [{"name": v.name, "reason": v.reason, "objects": len(v.mesh_nodes())}
                         for v in scene.variants],
            "materials": [{"name": m.name, "maps": {k: r.path for k, r in m.maps.items()},
                           "foliage": m.is_foliage} for m in scene.materials()],
            "warnings": scene.warnings,
        }, indent=1))
        return 0
    if not args.export:
        return -1
    st = load_settings()
    opts = ExportOptions.from_json(st.get("export", {}))
    if args.out:
        opts.out_dir = args.out
    if not opts.out_dir:
        print("--out is required", file=sys.stderr)
        return 2
    if args.split_variants:
        opts.split_variants = True
    if args.single_file:
        opts.split_variants = False
    if args.mode:
        opts.textures.mode = args.mode
    if args.embed:
        opts.embed_textures = True
    if args.no_center:
        opts.center_to_origin = False
    scene = load_any(args.export, lod=args.lod)
    vs = scene.variants
    if args.variants:
        want = {x.strip().lower() for x in args.variants.split(",")}
        vs = [v for v in vs if v.name.lower() in want]
        if not vs:
            print("No matching variants. Available: " + ", ".join(v.name for v in scene.variants),
                  file=sys.stderr)
            return 3
    res = export(scene, vs, None, opts, progress=lambda m, f: print(f"[{f * 100:5.1f}%] {m}"))
    print(open(res.report_path, encoding="utf-8").read())
    return 0
