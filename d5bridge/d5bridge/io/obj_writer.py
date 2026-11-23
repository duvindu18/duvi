"""Scene -> Wavefront OBJ + MTL.

OBJ cannot hold images inside the file, so textures are written next to the
.obj / .mtl (same folder, no sub-folder). Object transforms are baked, the
scene is converted to Y-up (what OBJ importers expect), n-gons are kept and
PBR maps use the common MTL extensions (map_Pr, map_Pm, norm, map_d).
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np

from ..scene import Material, Node, transform_normals, transform_points

_Z_TO_Y = np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], float)


def _fmt(arr: np.ndarray, prefix: str, fmt: str) -> str:
    if len(arr) == 0:
        return ""
    cols = arr.shape[1]
    line = prefix + " " + " ".join([fmt] * cols)
    return "\n".join(line % tuple(r) for r in arr.tolist()) + "\n"


def write_obj(path: str, roots: list[Node], up_axis: str, tex_paths: dict[int, dict[str, str]],
              base_alpha: set[int]) -> int:
    obj = Path(path)
    mtl = obj.with_suffix(".mtl")
    fix = _Z_TO_Y if up_axis == "Z" else np.eye(4)
    out = [f"# D5 Bridge OBJ export\nmtllib {mtl.name}\n"]
    v_off = vt_off = vn_off = 1
    mats: dict[int, Material] = {}

    for root in roots:
        for n in root.walk():
            m = n.mesh
            if m is None or m.num_faces == 0:
                continue
            world = fix @ n.world_matrix()
            pos = transform_points(world, m.positions)
            out.append(f"o {n.name}\n")
            out.append(_fmt(pos, "v", "%.6f"))
            has_uv = bool(m.uv_sets)
            has_n = m.normals is not None
            if has_uv:
                out.append(_fmt(m.uv_sets[0].attr.data, "vt", "%.6f"))
            if has_n:
                out.append(_fmt(transform_normals(world, m.normals.data), "vn", "%.5f"))
            cv = m.corner_verts.astype(np.int64) + v_off
            ct = (m.uv_sets[0].attr.index.astype(np.int64) + vt_off) if has_uv else None
            cn = (m.normals.index.astype(np.int64) + vn_off) if has_n else None
            if ct is not None and cn is not None:
                tok = [f"{a}/{b}/{c}" for a, b, c in zip(cv.tolist(), ct.tolist(), cn.tolist())]
            elif cn is not None:
                tok = [f"{a}//{c}" for a, c in zip(cv.tolist(), cn.tolist())]
            elif ct is not None:
                tok = [f"{a}/{b}" for a, b in zip(cv.tolist(), ct.tolist())]
            else:
                tok = [str(a) for a in cv.tolist()]
            starts = m.face_starts()
            sizes = m.face_sizes
            fm = m.face_material if m.face_material is not None else np.zeros(m.num_faces, np.int32)
            for slot in np.unique(fm):
                mat = n.materials[min(int(slot), len(n.materials) - 1)] if n.materials else Material("default")
                mats.setdefault(id(mat), mat)
                out.append(f"usemtl {mat.name}\n")
                faces = np.nonzero(fm == slot)[0]
                out.append("".join("f " + " ".join(tok[s:s + k]) + "\n"
                                   for s, k in zip(starts[faces].tolist(), sizes[faces].tolist())))
            v_off += m.num_vertices
            vt_off += len(m.uv_sets[0].attr.data) if has_uv else 0
            vn_off += len(m.normals.data) if has_n else 0

    obj.write_text("".join(out), encoding="utf-8")
    _write_mtl(mtl, list(mats.values()), tex_paths, base_alpha)
    return obj.stat().st_size + mtl.stat().st_size


def _write_mtl(mtl: Path, mats: list[Material], tex_paths: dict[int, dict[str, str]],
               base_alpha: set[int]) -> None:
    lines = ["# D5 Bridge materials (PBR extensions: map_Pr roughness, map_Pm metallic, norm normal)\n"]
    keys = {"base_color": "map_Kd", "opacity": "map_d", "normal": "norm", "bump": "map_bump",
            "roughness": "map_Pr", "metallic": "map_Pm", "emissive": "map_Ke", "ao": "map_ao"}
    for m in mats:
        r, g, b = m.base_color
        tex = tex_paths.get(id(m), {})
        lines.append(f"\nnewmtl {m.name}\n")
        lines.append(f"Kd {r:.4f} {g:.4f} {b:.4f}\nKa 0 0 0\nKs 0.04 0.04 0.04\n")
        lines.append(f"Pr {m.roughness:.4f}\nPm {m.metallic:.4f}\nd {m.opacity:.4f}\nillum 2\n")
        if any(m.emissive):
            lines.append("Ke %.4f %.4f %.4f\n" % tuple(m.emissive))
        for ch, key in keys.items():
            p = tex.get(ch)
            if not p:
                continue
            name = os.path.relpath(p, mtl.parent).replace("\\", "/")
            if ch == "normal":
                lines.append(f"norm {name}\nmap_bump -bm {m.normal_strength:.3f} {name}\n")
            else:
                lines.append(f"{key} {name}\n")
        if "opacity" not in tex and id(m) in base_alpha and tex.get("base_color"):
            lines.append(f"map_d -imfchan m {os.path.basename(tex['base_color'])}\n")
    mtl.write_text("".join(lines), encoding="utf-8")
