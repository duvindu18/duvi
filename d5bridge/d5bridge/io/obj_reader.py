"""Wavefront OBJ + MTL -> Scene (Megascans, Fab, Poliigon and others)."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from ..materials import finalize_material
from ..scene import IndexedAttr, Material, Mesh, Node, Scene, TextureRef, UVSet

_MTL_KEYS = {
    "map_kd": "base_color", "map_d": "opacity", "map_bump": "bump", "bump": "bump",
    "norm": "normal", "map_kn": "normal", "map_pr": "roughness", "map_pm": "metallic",
    "map_ke": "emissive", "map_ns": "glossiness", "disp": "displacement", "map_ao": "ao",
}


def _parse_map_args(parts: list[str], base: Path) -> TextureRef | None:
    scale = (1.0, 1.0)
    offset = (0.0, 0.0)
    i = 0
    while i < len(parts) and parts[i].startswith("-"):
        opt = parts[i]
        if opt in ("-s", "-o") and i + 2 < len(parts):
            v = (float(parts[i + 1]), float(parts[i + 2]))
            scale, offset = (v, offset) if opt == "-s" else (scale, v)
            i += 4 if i + 3 < len(parts) and _is_num(parts[i + 3]) else 3
            continue
        i += 2
    name = " ".join(parts[i:])
    if not name:
        return None
    p = Path(name.replace("\\", "/"))
    if not p.is_absolute():
        p = base / p
    if not p.is_file():
        alt = base / Path(name.replace("\\", "/")).name
        if alt.is_file():
            p = alt
    return TextureRef(str(p), uv_scale=scale, uv_offset=offset)


def _is_num(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def read_mtl(path: Path) -> dict[str, Material]:
    mats: dict[str, Material] = {}
    cur: Material | None = None
    if not path.is_file():
        return mats
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.strip().split()
        if not parts or parts[0].startswith("#"):
            continue
        key = parts[0].lower()
        if key == "newmtl":
            cur = Material(" ".join(parts[1:]) or "material", source_type="mtl")
            mats[cur.name] = cur
            continue
        if cur is None:
            continue
        if key == "kd" and len(parts) >= 4:
            cur.base_color = tuple(float(x) for x in parts[1:4])  # type: ignore[assignment]
        elif key == "d" and len(parts) >= 2:
            cur.opacity = float(parts[-1])
        elif key == "tr" and len(parts) >= 2:
            cur.opacity = 1.0 - float(parts[-1])
        elif key == "pr":
            cur.roughness = float(parts[1])
        elif key == "pm":
            cur.metallic = float(parts[1])
        elif key in _MTL_KEYS:
            ref = _parse_map_args(parts[1:], path.parent)
            if ref is None:
                continue
            ch = _MTL_KEYS[key]
            if ch == "glossiness":
                ch, ref.invert = "roughness", True
            if ch == "bump":
                from ..materials import guess_channel_from_filename
                if guess_channel_from_filename(ref.path) == "normal":
                    ch = "normal"
            cur.maps.setdefault(ch, ref)
    if cur is not None and cur.opacity <= 0:
        cur.opacity = 1.0
    return mats


def read_obj(path: str) -> Scene:
    p = Path(path)
    scene = Scene(source_path=str(p), source_kind="obj", up_axis="Y", unit_scale_cm=1.0)
    v_lines: list[str] = []
    vt_lines: list[str] = []
    vn_lines: list[str] = []
    mats: dict[str, Material] = {}

    groups: list[dict] = []
    cur: dict | None = None

    def new_group(name: str) -> dict:
        g = {"name": name, "faces": [], "mats": [], "mat_names": [], "cur_mat": None}
        groups.append(g)
        return g

    cur_mat_name = None
    with open(p, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if not line or line[0] == "#":
                continue
            t = line[:2]
            if t == "v ":
                v_lines.append(line[2:])
            elif t == "vt":
                vt_lines.append(line[3:])
            elif t == "vn":
                vn_lines.append(line[3:])
            elif t == "f ":
                if cur is None:
                    cur = new_group(p.stem)
                cur["faces"].append((line[2:].split(), len(v_lines), len(vt_lines), len(vn_lines)))
                cur["mats"].append(cur_mat_name)
            elif t in ("o ", "g "):
                name = line[2:].strip() or p.stem
                if cur is not None and not cur["faces"]:
                    cur["name"] = name
                else:
                    cur = new_group(name)
            elif line.startswith("usemtl"):
                cur_mat_name = line[6:].strip()
            elif line.startswith("mtllib"):
                for lib in [line[6:].strip()]:
                    mats.update(read_mtl(p.parent / lib))

    def arr(lines: list[str], width: int) -> np.ndarray:
        if not lines:
            return np.zeros((0, width))
        out = np.zeros((len(lines), width))
        for i, ln in enumerate(lines):
            vals = ln.split()[:width]
            out[i, :len(vals)] = [float(x) for x in vals]
        return out

    V, VT, VN = arr(v_lines, 3), arr(vt_lines, 2), arr(vn_lines, 3)
    default_mat = Material("default", source_type="obj")

    for g in groups:
        if not g["faces"]:
            continue
        sizes, cvi, cti, cni = [], [], [], []
        has_t = has_n = True
        for (toks, nv, nt, nn) in g["faces"]:
            sizes.append(len(toks))
            for tok in toks:
                parts = tok.split("/")
                vi = int(parts[0])
                cvi.append(vi - 1 if vi > 0 else nv + vi)
                if len(parts) > 1 and parts[1]:
                    ti = int(parts[1])
                    cti.append(ti - 1 if ti > 0 else nt + ti)
                else:
                    has_t = False
                    cti.append(0)
                if len(parts) > 2 and parts[2]:
                    ni = int(parts[2])
                    cni.append(ni - 1 if ni > 0 else nn + ni)
                else:
                    has_n = False
                    cni.append(0)
        cv_global = np.asarray(cvi, np.int64)
        used, cv_local = np.unique(cv_global, return_inverse=True)
        mesh = Mesh(g["name"], V[used].copy(), np.asarray(sizes, np.int32), cv_local.astype(np.int32))
        if has_t and len(VT):
            ti = np.asarray(cti, np.int64)
            ut, tl = np.unique(ti, return_inverse=True)
            mesh.uv_sets.append(UVSet("UVChannel_1", IndexedAttr(VT[ut].copy(), tl.astype(np.int32))))
        if has_n and len(VN):
            ni = np.asarray(cni, np.int64)
            un, nl = np.unique(ni, return_inverse=True)
            mesh.normals = IndexedAttr(VN[un].copy(), nl.astype(np.int32))
        else:
            mesh.compute_flat_normals()
        names: list[str | None] = []
        fm = np.zeros(len(sizes), np.int32)
        for i, mn in enumerate(g["mats"]):
            if mn not in names:
                names.append(mn)
            fm[i] = names.index(mn)
        mesh.face_material = fm
        node_mats = []
        for mn in names:
            if mn is None:
                node_mats.append(default_mat)
            else:
                node_mats.append(mats.setdefault(mn, Material(mn, source_type="obj")))
        scene.root.add(Node(g["name"], mesh=mesh, materials=node_mats))

    for m in mats.values():
        finalize_material(m)
    return scene
