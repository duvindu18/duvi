"""Automatic variant detection.

MaxTree / Evermotion / Megascans files often hold several versions of a plant
in one file. Each version is made of several objects (trunk, branches,
leaves...). Detection tries, in order:

1. Group nodes: two or more top-level groups/nulls that contain meshes.
2. Spatial clusters: top-level objects whose bounding boxes touch belong to
   the same tree; separate clusters are separate variants (MaxTree places
   versions side by side).
3. Name patterns: "Acer_01_leaves" + "Acer_01_trunk" vs "Acer_02_...".
4. Otherwise the whole file is one variant.
"""
from __future__ import annotations

import re
from collections import OrderedDict

import numpy as np

from .scene import Node, Scene, Variant, node_world_bounds

PART_WORDS = {
    "trunk", "bark", "leaf", "leaves", "branch", "branches", "twig", "twigs", "flower", "flowers",
    "fruit", "fruits", "stem", "stems", "needle", "needles", "mesh", "geo", "geometry", "poly",
    "polysurface", "cap", "caps", "root", "roots", "frond", "fronds", "petal", "petals", "blossom",
    "foliage", "cone", "cones", "seed", "seeds", "moss", "ivy", "grass", "blade", "blades", "atlas",
    "main", "part", "body", "lod0", "lod1", "lod2", "lod3", "lod", "obj", "object", "shape",
    "default", "base", "pot", "soil", "ground", "plane", "card", "cards", "billboard",
}


def _mesh_count(n: Node) -> int:
    return sum(1 for x in n.walk() if x.mesh is not None)


def _name_key(name: str) -> str:
    s = re.sub(r"([a-z])([A-Z])", r"\1_\2", name)
    toks = [t for t in re.split(r"[_\-\.\s:|]+", s.lower()) if t]
    toks = [t for t in toks if t not in PART_WORDS and not re.fullmatch(r"(lod|mat|mtl)\d*", t)]
    # trailing pure numbers after the variant id are part indices: "acer_01_leaves_003"
    while len(toks) > 1 and re.fullmatch(r"\d{3,}", toks[-1]):
        toks.pop()
    return "_".join(toks)


def _common_prefix(names: list[str]) -> str:
    if not names:
        return ""
    s1, s2 = min(names), max(names)
    i = 0
    while i < len(s1) and i < len(s2) and s1[i] == s2[i]:
        i += 1
    return s1[:i].rstrip("_- .")


def _variant_name(nodes: list[Node], idx: int) -> str:
    names = [n.name for n in nodes]
    if len(names) == 1:
        return names[0]
    pre = _common_prefix(names)
    return pre if len(pre) >= 3 else f"Variant {idx + 1}"


def by_groups(scene: Scene) -> list[Variant]:
    tops = [c for c in scene.root.children if _mesh_count(c) > 0]
    groups = [c for c in tops if c.mesh is None and _mesh_count(c) >= 1]
    if len(groups) >= 2 and len(groups) >= 0.5 * len(tops):
        out = [Variant(g.name, [g], reason="group") for g in groups]
        loose = [c for c in tops if c not in groups]
        for c in loose:
            out.append(Variant(c.name, [c], reason="loose object"))
        return out
    # single wrapper group with several sub-groups
    if len(tops) == 1 and tops[0].mesh is None:
        inner = [c for c in tops[0].children if _mesh_count(c) > 0]
        sub_groups = [c for c in inner if c.mesh is None]
        if len(sub_groups) >= 2:
            return [Variant(g.name, [g], reason="group") for g in sub_groups]
    return []


def by_space(scene: Scene, tops: list[Node] | None = None) -> list[Variant]:
    tops = tops if tops is not None else [c for c in scene.root.children if _mesh_count(c) > 0]
    if len(tops) < 2:
        return []
    boxes = []
    for n in tops:
        meshes = [x for x in n.walk() if x.mesh is not None and x.mesh.num_vertices]
        if not meshes:
            boxes.append(None)
            continue
        lo = np.min([node_world_bounds(m)[0] for m in meshes], axis=0)
        hi = np.max([node_world_bounds(m)[1] for m in meshes], axis=0)
        boxes.append((lo, hi))
    valid = [b for b in boxes if b is not None]
    if not valid:
        return []
    diag = float(np.linalg.norm(np.max([b[1] for b in valid], 0) - np.min([b[0] for b in valid], 0)))
    pad = diag * 0.005
    parent = list(range(len(tops)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i in range(len(tops)):
        for j in range(i + 1, len(tops)):
            a, b = boxes[i], boxes[j]
            if a is None or b is None:
                continue
            if np.all(a[0] - pad <= b[1]) and np.all(b[0] - pad <= a[1]):
                parent[find(i)] = find(j)
    clusters: "OrderedDict[int, list[Node]]" = OrderedDict()
    for i, n in enumerate(tops):
        clusters.setdefault(find(i), []).append(n)
    if len(clusters) < 2:
        return []
    groups = list(clusters.values())
    # order left-to-right along the widest axis
    centers = []
    for g in groups:
        idx = [tops.index(n) for n in g]
        bs = [boxes[k] for k in idx if boxes[k] is not None]
        centers.append(np.mean([(b[0] + b[1]) / 2 for b in bs], axis=0))
    axis = int(np.argmax(np.ptp(np.array(centers), axis=0)))
    order = np.argsort([c[axis] for c in centers])
    return [Variant(_variant_name(groups[k], i), groups[k], reason="separate position")
            for i, k in enumerate(order)]


def by_names(scene: Scene, tops: list[Node] | None = None) -> list[Variant]:
    tops = tops if tops is not None else [c for c in scene.root.children if _mesh_count(c) > 0]
    if len(tops) < 2:
        return []
    keys: "OrderedDict[str, list[Node]]" = OrderedDict()
    for n in tops:
        keys.setdefault(_name_key(n.name), []).append(n)
    if 2 <= len(keys) < len(tops):
        return [Variant(k or f"Variant {i + 1}", v, reason="name pattern")
                for i, (k, v) in enumerate(keys.items())]
    return []


def detect_variants(scene: Scene) -> list[Variant]:
    for fn in (by_groups, by_space, by_names):
        v = fn(scene)
        if v:
            return _dedupe_names(v)
    tops = [c for c in scene.root.children if _mesh_count(c) > 0]
    if not tops:
        return []
    from pathlib import Path
    name = Path(scene.source_path).stem if scene.source_path else "Model"
    return [Variant(name, tops, reason="whole file")]


def _dedupe_names(vs: list[Variant]) -> list[Variant]:
    seen: dict[str, int] = {}
    for v in vs:
        if v.name in seen:
            seen[v.name] += 1
            v.name = f"{v.name}_{seen[v.name]}"
        else:
            seen[v.name] = 1
    return vs
