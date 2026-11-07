"""Material types and their default generation settings."""
from __future__ import annotations

from dataclasses import asdict, dataclass, fields, replace
from typing import Any


@dataclass
class GenParams:
    preset: str = "generic"
    seamless: str = "periodic"       # periodic | blend | mirror | off
    blend_width: float = 0.5         # blend mode only, 0.05..1
    delight: float = 0.5             # remove baked-in lighting, 0..1
    delight_radius: float = 0.12     # size of the lighting gradients removed, fraction of the image
    height_detail: float = 0.5       # 0 = only fine detail, 1 = also large shapes
    height_smooth: float = 0.15      # 0..1
    height_contrast: float = 1.0     # 0.25..3
    invert_height: bool = False
    normal_strength: float = 2.5     # 0..10
    roughness: float = 0.7           # base value 0..1
    roughness_variation: float = 0.25
    metallic: float = 0.0
    ao_strength: float = 0.6
    ao_radius: float = 0.5           # 0..1

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict[str, Any] | None) -> "GenParams":
        d = d or {}
        known = {f.name for f in fields(cls)}
        base = for_preset(str(d.get("preset", "generic")))
        vals = {}
        for k, v in d.items():
            if k in known and k != "preset":
                t = type(getattr(base, k))
                vals[k] = (v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes")) if t is bool else t(v)
        return replace(base, **vals)


# name -> (label, overrides)
PRESETS: dict[str, tuple[str, dict[str, Any]]] = {
    "stucco":   ("Stucco",   dict(height_detail=0.35, height_smooth=0.25, normal_strength=2.0, roughness=0.85, roughness_variation=0.1, ao_strength=0.5)),
    "concrete": ("Concrete", dict(height_detail=0.4, height_smooth=0.1, normal_strength=2.2, roughness=0.8, roughness_variation=0.2, ao_strength=0.55)),
    "brick":    ("Brick",    dict(invert_height=True, height_detail=0.8, height_smooth=0.2, height_contrast=1.3, normal_strength=4.0, roughness=0.82, roughness_variation=0.15, ao_strength=0.8)),
    "stone":    ("Stone",    dict(height_detail=0.7, height_smooth=0.15, height_contrast=1.2, normal_strength=3.5, roughness=0.7, roughness_variation=0.25, ao_strength=0.75)),
    "wood":     ("Wood",     dict(height_detail=0.3, height_smooth=0.1, normal_strength=1.6, roughness=0.6, roughness_variation=0.3, ao_strength=0.35)),
    "metal":    ("Metal",    dict(delight=0.3, height_detail=0.25, height_smooth=0.05, normal_strength=1.0, roughness=0.35, roughness_variation=0.35, metallic=1.0, ao_strength=0.25)),
    "fabric":   ("Fabric",   dict(height_detail=0.2, height_smooth=0.0, normal_strength=2.0, roughness=0.92, roughness_variation=0.05, ao_strength=0.5)),
    "leather":  ("Leather",  dict(height_detail=0.3, height_smooth=0.1, normal_strength=2.4, roughness=0.55, roughness_variation=0.25, ao_strength=0.5)),
    "ground":   ("Ground",   dict(height_detail=0.75, height_smooth=0.1, height_contrast=1.2, normal_strength=3.5, roughness=0.9, roughness_variation=0.1, ao_strength=0.8)),
    "tile":     ("Tile",     dict(invert_height=True, height_detail=0.85, height_smooth=0.3, height_contrast=1.4, normal_strength=3.0, roughness=0.35, roughness_variation=0.4, ao_strength=0.7)),
    "plastic":  ("Plastic",  dict(delight=0.6, height_detail=0.2, height_smooth=0.3, normal_strength=1.0, roughness=0.45, roughness_variation=0.1, ao_strength=0.3)),
    "generic":  ("Generic",  dict()),
}


def preset_names() -> list[str]:
    return list(PRESETS.keys())


def preset_label(name: str) -> str:
    return PRESETS.get(name, PRESETS["generic"])[0]


def for_preset(name: str, **override: Any) -> GenParams:
    if name not in PRESETS:
        name = "generic"
    p = replace(GenParams(), preset=name, **PRESETS[name][1])
    return replace(p, **override) if override else p


# Slider ranges for the UI: name -> (label, min, max, step, decimals)
RANGES: dict[str, tuple[str, float, float, float, int]] = {
    "blend_width": ("Blend width", 0.05, 1.0, 0.01, 2),
    "delight": ("Remove lighting", 0.0, 1.0, 0.01, 2),
    "delight_radius": ("Lighting size", 0.02, 0.5, 0.01, 2),
    "height_detail": ("Height detail", 0.0, 1.0, 0.01, 2),
    "height_smooth": ("Height smoothing", 0.0, 1.0, 0.01, 2),
    "height_contrast": ("Height contrast", 0.25, 3.0, 0.01, 2),
    "normal_strength": ("Normal strength", 0.0, 10.0, 0.1, 1),
    "roughness": ("Roughness", 0.0, 1.0, 0.01, 2),
    "roughness_variation": ("Roughness variation", 0.0, 1.0, 0.01, 2),
    "metallic": ("Metallic", 0.0, 1.0, 0.01, 2),
    "ao_strength": ("AO strength", 0.0, 1.0, 0.01, 2),
    "ao_radius": ("AO radius", 0.0, 1.0, 0.01, 2),
}

