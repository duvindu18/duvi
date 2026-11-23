# -*- coding: utf-8 -*-
"""D5 Bridge - 3ds Max side exporter (runs INSIDE 3ds Max 2021+, Python 3 / pymxs).

Produces a "bundle" folder that the D5 Bridge app opens:

    <bundle>/scene.fbx        geometry, hierarchy, UVs, normals, material ids
    <bundle>/manifest.json    PBR materials converted from Corona / V-Ray /
                              Physical / Standard, object + layer + group info,
                              variant hints, warnings
    <bundle>/baked/*.png      procedural maps (Color Correct, Mix, Falloff,
                              Corona/V-Ray tints...) baked at full resolution
    <bundle>/thumbs/*.png     viewport thumbnail per variant (interactive only)

Run headless (what the D5 Bridge app does):
    3dsmaxbatch.exe d5bridge_batch.ms -sceneFile tree.max
    with env D5B_BUNDLE=<output folder>  D5B_OPTIONS=<json>

Or interactively: Scripting > Run Script > d5bridge_max_panel.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import traceback

import pymxs  # type: ignore

rt = pymxs.runtime
MANIFEST_VERSION = 2


# =========================================================================== #
# small pymxs helpers
# =========================================================================== #
def cls(obj) -> str:
    try:
        return str(rt.classOf(obj))
    except Exception:  # noqa: BLE001
        return ""


def has(obj, prop: str) -> bool:
    try:
        return bool(rt.isProperty(obj, rt.Name(prop)))
    except Exception:  # noqa: BLE001
        return False


def get(obj, *props, default=None):
    """First existing property of ``obj`` among ``props``."""
    for p in props:
        if has(obj, p):
            try:
                return rt.getProperty(obj, rt.Name(p))
            except Exception:  # noqa: BLE001
                continue
    return default


def is_map(v) -> bool:
    try:
        return v is not None and bool(rt.superClassOf(v) == rt.textureMap)
    except Exception:  # noqa: BLE001
        return False


def color3(c, default=(0.8, 0.8, 0.8)):
    try:
        return (float(c.r) / 255.0, float(c.g) / 255.0, float(c.b) / 255.0)
    except Exception:  # noqa: BLE001
        try:
            v = float(c)
            return (v, v, v)
        except Exception:  # noqa: BLE001
            return default


def num(v, default=0.0) -> float:
    try:
        return float(v)
    except Exception:  # noqa: BLE001
        return default


def on(obj, prop: str, default=True) -> bool:
    v = get(obj, prop)
    if v is None:
        return default
    try:
        return bool(v)
    except Exception:  # noqa: BLE001
        return default


SAFE = re.compile(r"[^A-Za-z0-9_\-]+")


def safe_name(name: str) -> str:
    s = SAFE.sub("_", str(name)).strip("_")
    return s or "unnamed"


# =========================================================================== #
# texture-map analysis
# =========================================================================== #
BITMAP_CLASSES = {"Bitmaptexture", "BitmapTexture", "CoronaBitmap", "VRayBitmap", "VRayHDRI",
                  "OSLMap"}
NORMAL_WRAPPERS = {"Normal_Bump", "CoronaNormal", "VRayNormalMap", "Normal Bump"}
PASSTHROUGH = {"Output", "VRayColor2Bump", "CoronaBumpConverter", "Gamma", "VRayUserColor",
               "CoronaTriplanar"}
# Wrappers that change colours: baked so D5 sees the same result.
BAKE_CLASSES = {"ColorCorrection", "Color_Correction", "CoronaColorCorrect", "VRayColorCorrection",
                "Mix", "CoronaMix", "VRayCompTex", "Falloff", "CoronaMultiMap", "MultiTexture",
                "VRayMultiSubTex", "RGB_Tint", "RGB_Multiply", "Composite", "CompositeTexturemap",
                "CoronaAO", "VRayDirt", "Noise", "Cellular", "Gradient", "Gradient_Ramp",
                "CoronaCurvature", "CoronaFrontBack", "VRayTriplanarTex", "Checker", "Tiles",
                "Mask", "CoronaColor", "VRayColor"}


def bitmap_path(tm) -> str:
    p = get(tm, "filename", "fileName", "HDRIMapName", "bitmapFile")
    if p is None and has(tm, "bitmap"):
        try:
            p = tm.bitmap.filename
        except Exception:  # noqa: BLE001
            p = None
    p = str(p) if p else ""
    if p and not os.path.isfile(p):
        try:
            resolved = rt.mapPaths.getFullFilePath(p)
            if resolved:
                p = str(resolved)
        except Exception:  # noqa: BLE001
            pass
    return p


def bitmap_coords(tm) -> dict:
    out = {"uv_scale": [1.0, 1.0], "uv_offset": [0.0, 0.0], "map_channel": 1}
    coords = get(tm, "coords", "Coordinates")
    if coords is not None:
        out["uv_scale"] = [num(get(coords, "U_Tiling", default=1), 1), num(get(coords, "V_Tiling", default=1), 1)]
        out["uv_offset"] = [num(get(coords, "U_Offset", default=0)), num(get(coords, "V_Offset", default=0))]
        out["map_channel"] = int(num(get(coords, "mapChannel", default=1), 1))
    else:
        # CoronaBitmap
        s = get(tm, "uvwScale", "tilingU")
        if s is not None:
            try:
                out["uv_scale"] = [num(s.x, 1), num(s.y, 1)]
            except Exception:  # noqa: BLE001
                out["uv_scale"] = [num(s, 1), num(get(tm, "tilingV", default=s), 1)]
        o = get(tm, "uvwOffset")
        if o is not None:
            try:
                out["uv_offset"] = [num(o.x), num(o.y)]
            except Exception:  # noqa: BLE001
                pass
        out["map_channel"] = int(num(get(tm, "mapChannel", "uvwChannel", default=1), 1))
    return out


def bitmap_size(path: str) -> tuple[int, int]:
    try:
        b = rt.openBitMap(path)
        if b is not None:
            w, h = int(b.width), int(b.height)
            rt.close(b)
            return w, h
    except Exception:  # noqa: BLE001
        pass
    return 2048, 2048


def deepest_bitmap(tm, depth=0):
    if tm is None or depth > 12:
        return None
    if cls(tm) in BITMAP_CLASSES and bitmap_path(tm):
        return tm
    try:
        n = int(rt.getNumSubTexmaps(tm))
    except Exception:  # noqa: BLE001
        n = 0
    for i in range(1, n + 1):
        try:
            sub = rt.getSubTexmap(tm, i)
        except Exception:  # noqa: BLE001
            sub = None
        found = deepest_bitmap(sub, depth + 1)
        if found is not None:
            return found
    return None


class Baker:
    def __init__(self, folder: str, enabled: bool, warnings: list) -> None:
        self.folder = folder
        self.enabled = enabled
        self.warnings = warnings
        self.cache: dict = {}

    def bake(self, tm, label: str) -> str:
        key = str(rt.getHandleByAnim(tm)) if hasattr(rt, "getHandleByAnim") else label
        if key in self.cache:
            return self.cache[key]
        inner = deepest_bitmap(tm)
        w, h = bitmap_size(bitmap_path(inner)) if inner is not None else (2048, 2048)
        os.makedirs(self.folder, exist_ok=True)
        out = os.path.join(self.folder, safe_name(label) + ".png")
        try:
            bm = rt.renderMap(tm, size=rt.Point2(w, h), filter=True, display=False)
            bm.filename = out
            rt.save(bm)
            rt.close(bm)
            self.cache[key] = out
            return out
        except Exception as e:  # noqa: BLE001
            self.warnings.append(f"Could not bake {cls(tm)} '{label}': {e}. Using its source bitmap.")
            path = bitmap_path(inner) if inner is not None else ""
            self.cache[key] = path
            return path


def analyse_map(tm, label: str, baker: Baker, as_normal=False) -> dict | None:
    """Return {"path", "invert", "uv_scale", "uv_offset", "flip_green", "bump", "baked"}."""
    if not is_map(tm):
        return None
    c = cls(tm)
    if c in BITMAP_CLASSES:
        p = bitmap_path(tm)
        if not p:
            return None
        d = {"path": p, "invert": False, "flip_green": False, "baked": False}
        d.update(bitmap_coords(tm))
        out = get(tm, "output")
        if out is not None and on(out, "invert", False):
            d["invert"] = True
        mono = get(tm, "monoOutput")
        if mono is not None and int(num(mono)) == 1:
            d["channel"] = "A"     # Bitmap "Alpha" mono output (opacity from alpha)
        return d
    if c in NORMAL_WRAPPERS:
        nmap = get(tm, "normal_map", "normalMap", "normal")
        d = analyse_map(nmap, label, baker) if is_map(nmap) else None
        if d is not None:
            flip = bool(on(tm, "flipgreen", False) or on(tm, "flip_green", False) or on(tm, "flipGreen", False))
            d["flip_green"] = flip
            d["strength"] = num(get(tm, "mult_spin", "multiplier", "normal_map_multiplier", "power", default=1.0), 1.0)
        bmap = get(tm, "bump_map", "bumpMap", "additionalBump")
        if is_map(bmap):
            bd = analyse_map(bmap, label + "_bump", baker)
            if d is None:
                return {"bump_only": bd}
            d["bump"] = bd
        return d
    if c in PASSTHROUGH:
        sub = get(tm, "map1", "map", "texmap", "inputTexmap", "Map", "input")
        if is_map(sub):
            return analyse_map(sub, label, baker, as_normal)
        return None
    # anything else: bake (colour-correct, mix, falloff, procedural...)
    if baker.enabled:
        p = baker.bake(tm, label)
        if p:
            return {"path": p, "invert": False, "flip_green": False, "baked": True,
                    "uv_scale": [1.0, 1.0], "uv_offset": [0.0, 0.0], "map_channel": 1,
                    "source_class": c}
    inner = deepest_bitmap(tm)
    if inner is not None:
        d = analyse_map(inner, label, baker, as_normal)
        if d is not None:
            d["note"] = f"{c} wrapper ignored (baking disabled)"
        return d
    return None


# =========================================================================== #
# material conversion
# =========================================================================== #
def blank_material(name: str, src: str) -> dict:
    return {"name": name, "source_type": src, "base_color": [0.8, 0.8, 0.8], "opacity": 1.0,
            "roughness": 0.5, "metallic": 0.0, "normal_strength": 1.0, "bump_strength": 1.0,
            "emissive": [0, 0, 0], "translucency": [0, 0, 0], "two_sided": False,
            "maps": {}, "notes": []}


def _slot(md: dict, ch: str, tm, enabled: bool, baker: Baker, amount: float = 1.0) -> None:
    if not enabled or not is_map(tm):
        return
    d = analyse_map(tm, f"{md['name']}_{ch}", baker, as_normal=(ch in ("normal", "bump")))
    if d is None:
        return
    if "bump_only" in d:
        if d["bump_only"]:
            md["maps"]["bump"] = d["bump_only"]
        return
    if ch == "bump":
        # a "bump" slot holding a normal wrapper is a normal map
        if cls(tm) in NORMAL_WRAPPERS or "strength" in d:
            md["maps"]["normal"] = d
            md["normal_strength"] = d.get("strength", 1.0) * amount
            if d.get("bump"):
                md["maps"]["bump"] = d["bump"]
            return
        md["bump_strength"] = amount
    md["maps"][ch] = d


def convert_material(m, baker: Baker) -> dict:
    c = cls(m)
    name = safe_name(m.name)
    md = blank_material(name, c)

    # ---- unwrap containers ------------------------------------------- #
    for wrapper, props in (("VRay2SidedMtl", ("frontMtl",)), ("VRayBlendMtl", ("baseMtl",)),
                           ("CoronaLayeredMtl", ("baseMtl",)), ("VRayOverrideMtl", ("baseMtl",)),
                           ("Shell_Material", ("originalMaterial",)),
                           ("CoronaRaySwitchMtl", ("directMtl", "giMtl")),
                           ("Blend", ("map1",)), ("DoubleSided", ("material1",)),
                           ("CoronaSelectMtl", ("mtls",)), ("VRayMtlWrapper", ("baseMtl",))):
        if c == wrapper:
            inner = get(m, *props)
            if isinstance(inner, (list, tuple)) or (inner is not None and hasattr(inner, "count")
                                                    and not hasattr(inner, "name")):
                try:
                    inner = inner[int(num(get(m, "selected", default=0)))]
                except Exception:  # noqa: BLE001
                    inner = None
            if inner is not None:
                sub = convert_material(inner, baker)
                sub["name"] = name
                sub["source_type"] = f"{c}>{sub['source_type']}"
                if c in ("VRay2SidedMtl", "DoubleSided"):
                    sub["two_sided"] = True
                    tr = get(m, "texmap_translucency")
                    if is_map(tr):
                        d = analyse_map(tr, f"{name}_translucency", baker)
                        if d:
                            sub["maps"]["translucency"] = d
                    else:
                        sub["translucency"] = list(color3(get(m, "translucency"), (0.5, 0.5, 0.5)))
                return sub
            md["notes"].append(f"{c}: empty container")
            return md

    if c == "CoronaPhysicalMtl":
        md["base_color"] = list(color3(get(m, "baseColor", "basecolor")))
        _slot(md, "base_color", get(m, "baseTexmap"), on(m, "baseTexmapOn"), baker)
        md["roughness"] = num(get(m, "baseRoughness", default=0.5), 0.5)
        gloss_mode = int(num(get(m, "roughnessMode", default=0))) == 1
        if gloss_mode:
            md["roughness"] = 1.0 - md["roughness"]
        _slot(md, "roughness", get(m, "baseRoughnessTexmap"), on(m, "baseRoughnessTexmapOn"), baker)
        if gloss_mode and "roughness" in md["maps"]:
            md["maps"]["roughness"]["invert"] = not md["maps"]["roughness"]["invert"]
        md["metallic"] = 1.0 if int(num(get(m, "metalnessMode", default=0))) == 1 else 0.0
        _slot(md, "metallic", get(m, "metalnessTexmap"), on(m, "metalnessTexmapOn"), baker)
        _slot(md, "bump", get(m, "baseBumpTexmap"), on(m, "baseBumpTexmapOn"), baker,
              num(get(m, "baseBumpMapAmount", default=1.0), 1.0))
        op_map = get(m, "opacityTexmap")
        _slot(md, "opacity", op_map, on(m, "opacityTexmapOn"), baker)
        md["opacity"] = num(get(m, "opacityLevel", default=1.0), 1.0)
        tf = num(get(m, "translucencyFraction", default=0.0))
        if tf > 0:
            md["translucency"] = [x * tf for x in color3(get(m, "translucencyColor"), (1, 1, 1))]
            _slot(md, "translucency", get(m, "translucencyColorTexmap"), on(m, "translucencyColorTexmapOn"), baker)
            if "translucency" not in md["maps"]:
                _slot(md, "translucency", get(m, "translucencyFractionTexmap"),
                      on(m, "translucencyFractionTexmapOn"), baker)
        md["two_sided"] = bool(on(m, "useThinMode", False)) or tf > 0
        md["emissive"] = [x * num(get(m, "selfIllumLevel", default=0.0)) for x in
                          color3(get(m, "selfIllumColor"), (1, 1, 1))]
        _slot(md, "emissive", get(m, "selfIllumTexmap"), on(m, "selfIllumTexmapOn"), baker)
        _slot(md, "displacement", get(m, "displacementTexmap"), on(m, "displacementTexmapOn"), baker)

    elif c in ("CoronaMtl", "CoronaLegacyMtl"):
        lvl = num(get(m, "levelDiffuse", default=1.0), 1.0)
        md["base_color"] = [x * lvl for x in color3(get(m, "colorDiffuse"))]
        _slot(md, "base_color", get(m, "texmapDiffuse"), on(m, "texmapOnDiffuse"), baker)
        gl = num(get(m, "reflectGlossiness", default=1.0), 1.0)
        refl = num(get(m, "levelReflect", default=0.0))
        md["roughness"] = 1.0 - gl if refl > 0 else 1.0
        _slot(md, "roughness", get(m, "texmapReflectGlossiness"), on(m, "texmapOnReflectGlossiness"), baker)
        if "roughness" in md["maps"]:
            md["maps"]["roughness"]["invert"] = not md["maps"]["roughness"]["invert"]
        _slot(md, "opacity", get(m, "texmapOpacity"), on(m, "texmapOnOpacity"), baker)
        md["opacity"] = num(get(m, "levelOpacity", default=1.0), 1.0)
        _slot(md, "bump", get(m, "texmapBump"), on(m, "texmapOnBump"), baker,
              num(get(m, "mapamountBump", default=1.0), 1.0))
        tl = num(get(m, "levelTranslucency", default=0.0))
        if tl > 0:
            md["translucency"] = [x * tl for x in color3(get(m, "colorTranslucency"), (1, 1, 1))]
            _slot(md, "translucency", get(m, "texmapTranslucency"), on(m, "texmapOnTranslucency"), baker)
            md["two_sided"] = True
        md["emissive"] = list(color3(get(m, "colorSelfIllum"), (0, 0, 0)))
        _slot(md, "emissive", get(m, "texmapSelfIllum"), on(m, "texmapOnSelfIllum"), baker)
        _slot(md, "displacement", get(m, "texmapDisplace"), on(m, "texmapOnDisplacement"), baker)

    elif c == "VRayMtl":
        md["base_color"] = list(color3(get(m, "diffuse")))
        _slot(md, "base_color", get(m, "texmap_diffuse"), on(m, "texmap_diffuse_on"), baker)
        use_rough = bool(on(m, "brdf_useRoughness", False))
        g = num(get(m, "reflection_glossiness", default=1.0), 1.0)
        md["roughness"] = g if use_rough else 1.0 - g
        _slot(md, "roughness", get(m, "texmap_reflectionGlossiness"), on(m, "texmap_reflectionGlossiness_on"), baker)
        if "roughness" in md["maps"] and not use_rough:
            md["maps"]["roughness"]["invert"] = not md["maps"]["roughness"]["invert"]
        refl = color3(get(m, "reflection"), (0, 0, 0))
        if max(refl) < 0.01 and "roughness" not in md["maps"]:
            md["roughness"] = 1.0
        md["metallic"] = num(get(m, "reflection_metalness", default=0.0))
        _slot(md, "metallic", get(m, "texmap_metalness"), on(m, "texmap_metalness_on"), baker)
        _slot(md, "opacity", get(m, "texmap_opacity"), on(m, "texmap_opacity_on"), baker)
        _slot(md, "bump", get(m, "texmap_bump"), on(m, "texmap_bump_on"), baker,
              num(get(m, "texmap_bump_multiplier", default=30.0), 30.0) / 100.0)
        if int(num(get(m, "translucency_on", default=0))) > 0:
            md["translucency"] = list(color3(get(m, "translucency_color"), (1, 1, 1)))
            md["two_sided"] = True
        md["emissive"] = [x * num(get(m, "selfIllumination_multiplier", default=1.0), 1.0)
                          for x in color3(get(m, "selfIllumination"), (0, 0, 0))]
        _slot(md, "emissive", get(m, "texmap_self_illumination"), on(m, "texmap_self_illumination_on"), baker)
        _slot(md, "displacement", get(m, "texmap_displacement"), on(m, "texmap_displacement_on"), baker)

    elif c == "PhysicalMaterial":
        md["base_color"] = list(color3(get(m, "base_color")))
        _slot(md, "base_color", get(m, "base_color_map"), on(m, "base_color_map_on"), baker)
        r = num(get(m, "roughness", default=0.5), 0.5)
        inv = bool(on(m, "roughness_inv", False))
        md["roughness"] = 1.0 - r if inv else r
        _slot(md, "roughness", get(m, "roughness_map"), on(m, "roughness_map_on"), baker)
        if inv and "roughness" in md["maps"]:
            md["maps"]["roughness"]["invert"] = not md["maps"]["roughness"]["invert"]
        md["metallic"] = num(get(m, "metalness", default=0.0))
        _slot(md, "metallic", get(m, "metalness_map"), on(m, "metalness_map_on"), baker)
        _slot(md, "bump", get(m, "bump_map"), on(m, "bump_map_on"), baker,
              num(get(m, "bump_map_amt", default=1.0), 1.0))
        _slot(md, "opacity", get(m, "cutout_map"), on(m, "cutout_map_on"), baker)
        md["two_sided"] = bool(on(m, "thin_walled", False))
        md["emissive"] = [x * num(get(m, "emission", default=0.0)) for x in
                          color3(get(m, "emit_color"), (1, 1, 1))]
        _slot(md, "emissive", get(m, "emission_map"), on(m, "emission_map_on"), baker)

    elif c in ("Standardmaterial", "StandardMaterial"):
        md["base_color"] = list(color3(get(m, "diffuse")))
        _slot(md, "base_color", get(m, "diffuseMap"), on(m, "diffuseMapEnable"), baker)
        _slot(md, "opacity", get(m, "opacityMap"), on(m, "opacityMapEnable"), baker)
        _slot(md, "bump", get(m, "bumpMap"), on(m, "bumpMapEnable"), baker,
              num(get(m, "bumpMapAmount", default=30.0), 30.0) / 100.0)
        _slot(md, "roughness", get(m, "glossinessMap"), on(m, "glossinessMapEnable"), baker)
        if "roughness" in md["maps"]:
            md["maps"]["roughness"]["invert"] = True
        md["opacity"] = num(get(m, "opacity", default=100.0), 100.0) / 100.0
        md["two_sided"] = bool(on(m, "twoSided", False))
        gl = num(get(m, "glossiness", default=10.0), 10.0) / 100.0
        md["roughness"] = 1.0 - gl

    elif c.startswith("Missing"):
        md["notes"].append("Renderer plug-in missing on this PC: material could not be read. "
                           "Textures are matched by file name instead.")
        md["missing_plugin"] = True
    else:
        # generic fallback: try common diffuse properties, then any bitmap
        tm = get(m, "texmap_diffuse", "diffuseMap", "baseTexmap", "base_color_map", "texmapDiffuse")
        _slot(md, "base_color", tm, True, baker)
        md["notes"].append(f"Unsupported material type {c}: only the colour map was converted")

    # leaf heuristics
    lname = name.lower()
    if "opacity" in md["maps"] or any(k in lname for k in ("leaf", "leaves", "foliage", "needle")):
        md["two_sided"] = True
        md["is_foliage"] = True
    if md["opacity"] <= 0.0:
        md["opacity"] = 1.0
    return md


def collect_materials(nodes, baker: Baker, warnings: list) -> dict:
    """Make every (sub)material name unique and convert them all."""
    out: dict = {}
    used: dict = {}
    seen: dict = {}

    def unique(mat) -> None:
        h = str(rt.getHandleByAnim(mat))
        if h in seen:
            return
        base = safe_name(mat.name)
        n = base
        i = 1
        while n in used:
            i += 1
            n = f"{base}_{i}"
        used[n] = True
        seen[h] = n
        mat.name = n

    def visit(mat) -> None:
        if mat is None:
            return
        if cls(mat) in ("Multimaterial", "MultiMaterial", "VRayMultiSubMtl"):
            try:
                for sub in list(mat.materialList):
                    visit(sub)
            except Exception:  # noqa: BLE001
                pass
            return
        unique(mat)
        h = str(rt.getHandleByAnim(mat))
        name = seen[h]
        if name in out:
            return
        try:
            out[name] = convert_material(mat, baker)
            out[name]["name"] = name
        except Exception as e:  # noqa: BLE001
            warnings.append(f"Material {name}: conversion failed ({e})")
            out[name] = blank_material(name, cls(mat))

    for n in nodes:
        visit(n.material)
    return out


# =========================================================================== #
# scene info
# =========================================================================== #
GEOMETRY_SKIP = {"Targetobject", "TargetObject"}


def exportable_nodes():
    out = []
    for n in rt.objects:
        try:
            if rt.superClassOf(n) == rt.GeometryClass and cls(n) not in GEOMETRY_SKIP:
                out.append(n)
            elif rt.isGroupHead(n):
                out.append(n)
        except Exception:  # noqa: BLE001
            continue
    return out


def make_node_names_unique(nodes) -> None:
    used = set()
    for n in nodes:
        base = safe_name(n.name)
        name = base
        i = 1
        while name.lower() in used:
            i += 1
            name = f"{base}_{i}"
        used.add(name.lower())
        if name != n.name:
            n.name = name


def proxy_warnings(nodes, warnings: list) -> None:
    for n in nodes:
        c = cls(n)
        if c in ("CProxy", "VRayProxy", "CoronaProxy", "Forest_Pro", "RailClone_Pro",
                 "CoronaScatter", "VRayScatter", "MultiScatter"):
            warnings.append(f"{n.name}: {c} is not real geometry. Convert it to Editable Poly "
                            "(or use 'Convert proxies' option) to export it.")


def convert_proxies(nodes, warnings: list) -> None:
    for n in nodes:
        c = cls(n)
        if c in ("CProxy", "CoronaProxy", "VRayProxy"):
            try:
                if c == "VRayProxy" and has(n, "display"):
                    n.display = 4           # whole mesh
                rt.convertToPoly(n)
            except Exception as e:  # noqa: BLE001
                warnings.append(f"{n.name}: could not convert {c} to mesh ({e})")


def node_info(n) -> dict:
    parent = n.parent
    layer = ""
    try:
        layer = str(n.layer.name)
    except Exception:  # noqa: BLE001
        pass
    mat = n.material
    return {
        "name": str(n.name),
        "handle": int(n.inode.handle) if hasattr(n, "inode") else 0,
        "class": cls(n),
        "parent": str(parent.name) if parent is not None else "",
        "layer": layer,
        "is_group_head": bool(rt.isGroupHead(n)),
        "is_group_member": bool(rt.isGroupMember(n)),
        "hidden": bool(n.isHidden),
        "material": str(mat.name) if mat is not None else "",
        "material_class": cls(mat) if mat is not None else "",
        "faces": int(num(rt.getPolygonCount(n)[0])) if rt.superClassOf(n) == rt.GeometryClass else 0,
    }


def variant_hints(nodes) -> dict:
    groups = {}
    layers: dict = {}
    for n in nodes:
        try:
            if rt.isGroupHead(n) and (n.parent is None or not rt.isGroupHead(n.parent)):
                members = []
                stack = list(n.children)
                while stack:
                    c = stack.pop()
                    members.append(str(c.name))
                    stack.extend(list(c.children))
                groups[str(n.name)] = members
            layers.setdefault(str(n.layer.name), []).append(str(n.name))
        except Exception:  # noqa: BLE001
            continue
    sel_sets = {}
    try:
        for ss in rt.selectionSets:
            sel_sets[str(ss.name)] = [str(o.name) for o in ss]
    except Exception:  # noqa: BLE001
        pass
    return {"groups": groups, "layers": layers, "selection_sets": sel_sets}


def scene_assets() -> list:
    """All bitmap paths the .max file references (works even without the renderer)."""
    paths = []
    try:
        for i in range(1, rt.AssetManager.GetNumAssets() + 1):
            a = rt.AssetManager.GetAssetByIndex(i)
            if str(a.GetType()) in ("#bitmap", "bitmap"):
                paths.append(str(a.GetFileName()))
    except Exception:  # noqa: BLE001
        try:
            for f in rt.usedMaps():
                paths.append(str(f))
        except Exception:  # noqa: BLE001
            pass
    resolved = []
    for p in paths:
        q = p
        if not os.path.isfile(q):
            try:
                q = str(rt.mapPaths.getFullFilePath(p)) or p
            except Exception:  # noqa: BLE001
                q = p
        resolved.append(q)
    return sorted(set(resolved))


def renderer_name() -> str:
    try:
        return str(rt.classOf(rt.renderers.current))
    except Exception:  # noqa: BLE001
        return ""


# =========================================================================== #
# FBX export
# =========================================================================== #
def export_fbx(path: str, selected_only: bool, opts: dict) -> None:
    rt.FBXExporterSetParam("ResetExport")
    params = {
        "Animation": False, "Cameras": False, "Lights": False, "EmbedTextures": False,
        "SmoothingGroups": True, "TangentSpaceExport": False, "Triangulate": False,
        "PreserveInstances": True, "SmoothMeshExport": False, "Skin": False, "Shape": False,
        "GeomAsBone": False, "ASCII": False, "ShowWarnings": False, "GenerateLog": False,
        "UpAxis": opts.get("up_axis", "Y"), "ConvertUnit": opts.get("units", "cm"),
        "ScaleFactor": 1.0, "FileVersion": "FBX201800", "Collision": False,
        "PointCache": False, "BakeAnimation": False, "UseSceneName": False,
        "SelectionSetExport": False, "AxisConversionMethod": "Animation",
    }
    for k, v in params.items():
        try:
            rt.FBXExporterSetParam(k, v)
        except Exception:  # noqa: BLE001
            pass
    if selected_only:
        rt.exportFile(path, rt.Name("noPrompt"), selectedOnly=True, using=rt.FBXEXP)
    else:
        rt.exportFile(path, rt.Name("noPrompt"), using=rt.FBXEXP)


def capture_thumbnails(folder: str, hints: dict, warnings: list) -> dict:
    """One thumbnail per group/layer variant (interactive sessions only)."""
    out = {}
    os.makedirs(folder, exist_ok=True)
    try:
        prev_sel = list(rt.selection)
        for name, members in list(hints.get("groups", {}).items())[:24]:
            objs = [rt.getNodeByName(m) for m in members]
            objs = [o for o in objs if o is not None]
            if not objs:
                continue
            rt.select(objs)
            rt.IsolateSelection.EnterIsolateSelectionMode()
            rt.viewport.setType(rt.Name("view_persp_user"))
            rt.execute("max zoomext sel")
            rt.completeRedraw()
            dib = rt.gw.getViewportDib()
            p = os.path.join(folder, safe_name(name) + ".png")
            dib.filename = p
            rt.save(dib)
            rt.close(dib)
            rt.IsolateSelection.ExitIsolateSelectionMode()
            out[name] = p
        rt.select(prev_sel)
    except Exception as e:  # noqa: BLE001
        warnings.append(f"Thumbnails skipped: {e}")
    return out


# =========================================================================== #
def export_bundle(bundle_dir: str, options: dict | None = None, selected_only: bool = False) -> str:
    """Create the bundle. Returns the manifest path."""
    opts = dict(options or {})
    t0 = time.time()
    os.makedirs(bundle_dir, exist_ok=True)
    warnings: list = []
    interactive = not bool(opts.get("batch", False))
    if interactive:
        rt.holdMaxFile()     # everything below is undone afterwards
    try:
        nodes = list(rt.selection) if selected_only else exportable_nodes()
        if selected_only:
            extra = []
            for n in nodes:
                stack = list(n.children)
                while stack:
                    c = stack.pop()
                    extra.append(c)
                    stack.extend(list(c.children))
            nodes = list({int(n.inode.handle): n for n in nodes + extra}.values())
        proxy_warnings(nodes, warnings)
        if opts.get("convert_proxies", True):
            convert_proxies(nodes, warnings)
        # hidden objects are exported too (MaxTree often hides alternative variants)
        for n in nodes:
            try:
                if n.isHidden:
                    n.isHidden = False
            except Exception:  # noqa: BLE001
                pass
        make_node_names_unique(nodes)
        baker = Baker(os.path.join(bundle_dir, "baked"), bool(opts.get("bake_procedural", True)), warnings)
        materials = collect_materials([n for n in nodes if rt.superClassOf(n) == rt.GeometryClass],
                                      baker, warnings)
        infos = [node_info(n) for n in nodes]
        hints = variant_hints(nodes)
        thumbs = capture_thumbnails(os.path.join(bundle_dir, "thumbs"), hints, warnings) \
            if opts.get("thumbnails", True) and interactive else {}
        fbx_path = os.path.join(bundle_dir, "scene.fbx")
        if selected_only:
            rt.select(nodes)
        export_fbx(fbx_path, selected_only, opts)
        manifest = {
            "version": MANIFEST_VERSION,
            "generator": "D5 Bridge 3ds Max exporter",
            "max_file": os.path.join(str(rt.maxFilePath), str(rt.maxFileName)),
            "max_version": int(rt.maxVersion()[0]),
            "renderer": renderer_name(),
            "system_units": str(rt.units.SystemType),
            "fbx": "scene.fbx",
            "fbx_units": opts.get("units", "cm"),
            "nodes": infos,
            "materials": materials,
            "variant_hints": hints,
            "thumbnails": thumbs,
            "scene_assets": scene_assets(),
            "warnings": warnings,
            "seconds": round(time.time() - t0, 2),
        }
        mpath = os.path.join(bundle_dir, "manifest.json")
        with open(mpath, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=1)
        return mpath
    finally:
        if interactive:
            rt.fetchMaxFile(quiet=True)


def _batch_main() -> None:
    bundle = os.environ.get("D5B_BUNDLE", "")
    try:
        options = json.loads(os.environ.get("D5B_OPTIONS", "{}") or "{}")
    except ValueError:
        options = {}
    options["batch"] = True
    if not bundle:
        print("D5B_BUNDLE not set", file=sys.stderr)
        return
    try:
        path = export_bundle(bundle, options)
        print("D5BRIDGE_OK " + path)
    except Exception:  # noqa: BLE001
        err = traceback.format_exc()
        os.makedirs(bundle, exist_ok=True)
        with open(os.path.join(bundle, "error.txt"), "w", encoding="utf-8") as f:
            f.write(err)
        print("D5BRIDGE_FAIL\n" + err)


if os.environ.get("D5B_BUNDLE") and __name__ in ("__main__", "builtins", "__builtin__"):
    _batch_main()
