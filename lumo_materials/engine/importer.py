"""Importing ready-made map sets: guessing what each file is and assembling a complete set."""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import maps as gen
from .imageio import load_gray, load_rgb, resize
from .presets import GenParams

MAX_FILES = 24

ROLES = ("albedo", "normal", "roughness", "gloss", "metallic", "height", "ao", "orm", "ignore")
ROLE_LABELS = {
    "albedo": "Albedo / colour", "normal": "Normal", "roughness": "Roughness", "gloss": "Gloss (inverted to roughness)",
    "metallic": "Metallic", "height": "Height / displacement", "ao": "Ambient occlusion",
    "orm": "Packed ORM (R=AO, G=rough, B=metal)", "ignore": "Ignore",
}

# Ordered: the first match wins. Tokens are matched on word boundaries of the file stem.
_PATTERNS: list[tuple[str, str]] = [
    (r"(normal|nrm|nor|norm)[ _\-.]?(gl|opengl)", "normal:gl"),
    (r"(normal|nrm|nor|norm)[ _\-.]?(dx|directx)", "normal:dx"),
    (r"(orm|arm|occlusion[ _\-.]?roughness[ _\-.]?metal(lic|ness)?)", "orm"),
    (r"(basecolou?r|base[ _\-.]colou?r|albedo|diffuse|diff|colou?r|col|basecol|alb)", "albedo"),
    (r"(normal|nrm|nor|norm|nml)", "normal"),
    (r"(roughness|rough|rgh)", "roughness"),
    (r"(glossiness|gloss|smoothness)", "gloss"),
    (r"(metallic|metalness|metal|mtl)", "metallic"),
    (r"(displacement|disp|height|heightmap|bump|depth)", "height"),
    (r"(ambient[ _\-.]?occlusion|occlusion|ao)", "ao"),
    (r"(specular|spec|emissive|emission|opacity|alpha|mask|id|preview|thumb|sphere)", "ignore"),
]
_COMPILED = [(re.compile(r"(?:^|[ _\-.])" + p + r"(?:$|[ _\-.\d])", re.I), r) for p, r in _PATTERNS]


@dataclass
class Assignment:
    path: str
    role: str                 # one of ROLES
    convention: str = "gl"    # normal maps only: gl | dx


def guess(path: str | Path) -> tuple[str, str]:
    """-> (role, convention). Unknown files become 'ignore'."""
    stem = Path(path).stem
    best: tuple[int, int, str] | None = None   # (end position, -pattern order, role): rightmost token wins
    for order, (rx, role) in enumerate(_COMPILED):
        for m in rx.finditer(stem):
            cand = (m.end(), -order, role)
            if best is None or cand > best:
                best = cand
    if best is None:
        return "ignore", "gl"
    role = best[2]
    if role.startswith("normal:"):
        return "normal", role.split(":")[1]
    return role, "gl"


def guess_all(paths: list[str | Path]) -> list[Assignment]:
    """Guesses every file; when two files claim the same role, the larger file wins and the other is ignored."""
    out = []
    for p in paths[:MAX_FILES]:
        role, conv = guess(p)
        out.append(Assignment(str(p), role, conv))
    by_role: dict[str, list[Assignment]] = {}
    for a in out:
        if a.role != "ignore":
            by_role.setdefault(a.role, []).append(a)
    for role, items in by_role.items():
        if len(items) > 1:
            if role == "normal":   # prefer an explicit OpenGL normal
                items.sort(key=lambda a: (a.convention != "gl", -Path(a.path).stat().st_size if Path(a.path).exists() else 0))
            else:
                items.sort(key=lambda a: -Path(a.path).stat().st_size if Path(a.path).exists() else 0)
            for extra in items[1:]:
                extra.role = "ignore"
    return out


class ImportError_(ValueError):
    pass


def assemble(assignments: list[Assignment], params: GenParams, generate_missing: bool = True
             ) -> tuple[dict[str, np.ndarray], list[str]]:
    """Loads the assigned files and returns (maps, generated_names). Imported maps are used as given;
    normal maps in DirectX convention are flipped to OpenGL."""
    loaded: dict[str, np.ndarray] = {}
    for a in assignments:
        if a.role == "ignore":
            continue
        if a.role in loaded and a.role != "orm":
            raise ImportError_(f"Two files are assigned to {ROLE_LABELS[a.role]}.")
        if a.role == "albedo":
            loaded["albedo"] = load_rgb(a.path)
        elif a.role == "normal":
            n = load_rgb(a.path)
            if a.convention == "dx":
                n = n.copy()
                n[..., 1] = 1.0 - n[..., 1]
            loaded["normal"] = n
        elif a.role == "orm":
            orm = load_rgb(a.path)
            loaded.setdefault("ao", orm[..., 0].copy())
            loaded.setdefault("roughness", orm[..., 1].copy())
            loaded.setdefault("metallic", orm[..., 2].copy())
        elif a.role == "gloss":
            loaded["roughness"] = 1.0 - load_gray(a.path)
        else:
            loaded[a.role] = load_gray(a.path)

    if not loaded:
        raise ImportError_("No file is assigned to a map.")
    ref = loaded.get("albedo")
    if ref is None:
        ref = max(loaded.values(), key=lambda x: x.shape[0] * x.shape[1])
    h, w = ref.shape[:2]
    for k, v in list(loaded.items()):
        if v.shape[:2] != (h, w):
            loaded[k] = resize(v, w, h)

    generated: list[str] = []
    if "albedo" not in loaded:
        loaded["albedo"] = np.full((h, w, 3), 0.5, np.float32)
        generated.append("albedo")
    if not generate_missing:
        return loaded, generated

    alb = loaded["albedo"]
    if "height" not in loaded:
        loaded["height"] = gen.height_from(alb, params)
        generated.append("height")
    if "normal" not in loaded:
        loaded["normal"] = gen.normal_from(loaded["height"], params.normal_strength)
        generated.append("normal")
    if "roughness" not in loaded:
        loaded["roughness"] = gen.roughness_from(alb, loaded["height"], params)
        generated.append("roughness")
    if "metallic" not in loaded:
        loaded["metallic"] = np.full((h, w), float(params.metallic), np.float32)
        generated.append("metallic")
    if "ao" not in loaded:
        loaded["ao"] = gen.ao_from(loaded["height"], params.ao_strength, params.ao_radius)
        generated.append("ao")
    return {k: loaded[k] for k in ("albedo", "normal", "roughness", "metallic", "height", "ao")}, generated
