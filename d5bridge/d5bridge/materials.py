"""Texture-channel detection and PBR helpers shared by all importers."""
from __future__ import annotations

import re
from pathlib import Path

from .scene import Material, TextureRef

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".tga", ".bmp", ".exr",
              ".hdr", ".dds", ".psd", ".webp"}

# Ordered: first match wins. Patterns are matched against the lower-case stem
# split into tokens on "_", "-", ".", " " and camelCase boundaries.
_FILENAME_RULES: list[tuple[str, tuple[str, ...]]] = [
    ("normal",       ("normal", "nrm", "nor", "normalmap", "nml", "norm", "nmap", "normalgl", "normaldx")),
    ("opacity",      ("opacity", "alpha", "mask", "transparency", "cutout", "opac", "trans_mask", "op")),
    ("translucency", ("translucency", "translucent", "transmission", "sss", "subsurface", "backlight", "transl")),
    ("glossiness",   ("gloss", "glossiness", "gls", "smoothness")),
    ("roughness",    ("roughness", "rough", "rgh", "roughnes")),
    ("metallic",     ("metallic", "metalness", "metal", "met")),
    ("ao",           ("ao", "ambientocclusion", "occlusion", "cavity_ao", "occ")),
    ("displacement", ("displacement", "disp", "height", "heightmap", "dsp")),
    ("bump",         ("bump", "bmp")),
    ("specular",     ("specular", "spec", "reflection", "refl", "spc")),
    ("emissive",     ("emissive", "emission", "emit", "glow", "selfillum")),
    ("base_color",   ("albedo", "basecolor", "base_color", "diffuse", "diff", "color", "col",
                      "colour", "dif", "base", "bc", "alb", "d")),
]


def _tokens(stem: str) -> list[str]:
    s = re.sub(r"([a-z])([A-Z])", r"\1_\2", stem)
    return [t for t in re.split(r"[_\-\.\s]+", s.lower()) if t]


def guess_channel_from_filename(path: str) -> str | None:
    stem = Path(path).stem
    toks = _tokens(stem)
    joined = stem.lower().replace("-", "_").replace(" ", "_")
    # look at the trailing tokens first: "Tree_A_leaf_Normal_4K" -> normal
    for tok in reversed(toks):
        if re.fullmatch(r"\d+k|lod\d+|\d+|v\d+|var\d+|[a-z]\d", tok):
            continue
        for ch, keys in _FILENAME_RULES:
            if tok in keys:
                return ch
    for ch, keys in _FILENAME_RULES:
        for k in keys:
            if len(k) >= 4 and k in joined:
                return ch
    return None


# FBX material property name -> channel
def channel_from_fbx_property(prop: str) -> str | None:
    p = prop.lower()
    if not p:
        return None
    if "normal" in p:
        return "normal"
    if "bump" in p:
        return "bump"
    if "transparen" in p or "opacity" in p or "cutout" in p:
        return "opacity"
    if "translucen" in p or "transmission" in p or "subsurface" in p or "sss" in p:
        return "translucency"
    if "gloss" in p:
        return "glossiness"
    if "rough" in p:
        return "roughness"
    if "shininess" in p:
        return "glossiness"
    if "metal" in p:
        return "metallic"
    if "emissive" in p or "emission" in p or "selfillum" in p:
        return "emissive"
    if "displacement" in p or "height" in p:
        return "displacement"
    if "occlusion" in p or p.endswith("ao_map") or "|ao" in p:
        return "ao"
    if "diffuse" in p or "base_color" in p or "basecolor" in p or "albedo" in p or p.endswith("color_map"):
        return "base_color"
    if "specular" in p or "reflection" in p:
        return "specular"
    return None


FOLIAGE_HINTS = ("leaf", "leaves", "foliage", "needle", "frond", "petal", "flower", "grass",
                 "blade", "twig", "atlas", "bark_leaf", "branch_leaf", "plant", "ivy", "fern")


def looks_like_foliage(mat: Material) -> bool:
    name = mat.name.lower()
    if "opacity" in mat.maps or "translucency" in mat.maps:
        return True
    if any(h in name for h in FOLIAGE_HINTS):
        return True
    bc = mat.maps.get("base_color")
    return bool(bc and any(h in Path(bc.path).stem.lower() for h in FOLIAGE_HINTS))


def finalize_material(mat: Material) -> Material:
    """Normalise a material after import: flags and sane defaults."""
    if looks_like_foliage(mat):
        mat.is_foliage = True
        mat.two_sided = True
    # A specular-only map is a poor roughness source; keep it but note it.
    if "roughness" not in mat.maps and "specular" in mat.maps:
        mat.notes.append("only a specular map was found; roughness uses the constant value")
    return mat


def collect_textures_for_stem(folder: Path, stem_hint: str = "") -> dict[str, TextureRef]:
    """Find PBR maps in a folder (Megascans / loose texture sets)."""
    found: dict[str, TextureRef] = {}
    scores: dict[str, int] = {}
    if not folder.is_dir():
        return found
    hint = stem_hint.lower()
    for f in sorted(folder.iterdir()):
        if f.suffix.lower() not in IMAGE_EXTS or not f.is_file():
            continue
        ch = guess_channel_from_filename(f.name)
        if ch is None:
            continue
        score = 0
        stem = f.stem.lower()
        if hint and hint in stem:
            score += 10
        if "preview" in stem or "thumb" in stem:
            score -= 50
        # prefer higher resolution and lossless sources
        m = re.search(r"(\d+)k", stem)
        if m:
            score += int(m.group(1))
        if f.suffix.lower() in (".exr",):
            score -= 3       # D5 is happier with 8/16-bit images for these maps
        if f.suffix.lower() in (".png", ".tif", ".tiff"):
            score += 1
        if ch == "normal" and ("lod" in stem and not stem.endswith("lod0")):
            score -= 1
        invert = False
        if ch == "glossiness":
            ch, invert = "roughness", True
        elif ch == "roughness":
            score += 100     # a real roughness map beats an inverted gloss map
        if ch not in found or score > scores[ch]:
            found[ch] = TextureRef(str(f), invert=invert)
            scores[ch] = score
    return found
