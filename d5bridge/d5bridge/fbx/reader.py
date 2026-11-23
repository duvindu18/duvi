"""FBX (binary 6.1-7.7 and ASCII 7.x) -> Scene.

Reads the parts that matter for static assets: hierarchy and full FBX
transform stack (pivots, pre/post rotation, geometric offsets), polygon meshes
with n-gons, normals, all UV channels, per-face material ids, materials and
their texture connections (Phong/Lambert, 3ds Max Physical, Stingray PBS),
and embedded media.
"""
from __future__ import annotations

import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import numpy as np

from ..scene import (IndexedAttr, Material, Mesh, Node, Scene, TextureRef, UVSet,
                     euler_matrix, scale_matrix, translation_matrix)
from ..materials import channel_from_fbx_property, finalize_material, guess_channel_from_filename
from .binary import FBXNode, Raw, read_fbx_tree

TEXTURE_SUBDIRS = ("", "textures", "Textures", "maps", "Maps", "tex", "images", "..",
                   "../textures", "../Textures", "../maps")


# --------------------------------------------------------------------------- #
def _props70(node: FBXNode) -> dict[str, list[Any]]:
    out: dict[str, list[Any]] = {}
    p = node.find("Properties70") or node.find("Properties60")
    if p is None:
        return out
    for e in p.children:
        if e.name in ("P", "Property") and e.props:
            out[str(e.props[0])] = e.props[4:] if e.name == "P" else e.props[3:]
    return out


def _vec(props: dict, key: str, default=(0.0, 0.0, 0.0)) -> np.ndarray:
    v = props.get(key)
    if not v or len(v) < 3:
        return np.array(default, dtype=np.float64)
    return np.array([float(x) for x in v[:3]], dtype=np.float64)


def _num(props: dict, key: str, default: float) -> float:
    v = props.get(key)
    if not v:
        return default
    try:
        return float(v[0])
    except (TypeError, ValueError):
        return default


def _clean_name(s: str) -> str:
    # binary: "Name\x00\x01Class"; ascii: "Class::Name"
    if "\x00\x01" in s:
        return s.split("\x00\x01")[0]
    if "::" in s:
        return s.split("::", 1)[1]
    return s


# --------------------------------------------------------------------------- #
def model_local_matrix(props: dict) -> tuple[np.ndarray, np.ndarray]:
    """Return (local matrix, geometric offset matrix) per the FBX SDK formula."""
    t = _vec(props, "Lcl Translation")
    r = _vec(props, "Lcl Rotation")
    s = _vec(props, "Lcl Scaling", (1, 1, 1))
    rot_active = bool(_num(props, "RotationActive", 0))
    order = int(_num(props, "RotationOrder", 0)) if rot_active else 0
    pre = _vec(props, "PreRotation") if rot_active else np.zeros(3)
    post = _vec(props, "PostRotation") if rot_active else np.zeros(3)
    roff = _vec(props, "RotationOffset")
    rpiv = _vec(props, "RotationPivot")
    soff = _vec(props, "ScalingOffset")
    spiv = _vec(props, "ScalingPivot")

    m = (translation_matrix(t) @ translation_matrix(roff) @ translation_matrix(rpiv)
         @ euler_matrix(pre) @ euler_matrix(r, order) @ np.linalg.inv(euler_matrix(post))
         @ translation_matrix(-rpiv) @ translation_matrix(soff) @ translation_matrix(spiv)
         @ scale_matrix(s) @ translation_matrix(-spiv))

    gt = _vec(props, "GeometricTranslation")
    gr = _vec(props, "GeometricRotation")
    gs = _vec(props, "GeometricScaling", (1, 1, 1))
    g = translation_matrix(gt) @ euler_matrix(gr) @ scale_matrix(gs)
    return m, g


def _layer_index(elem: FBXNode, data_key: str, index_keys: tuple[str, ...], width: int,
                 corner_verts: np.ndarray, corner_face: np.ndarray) -> IndexedAttr | None:
    raw = elem.value(data_key)
    if raw is None:
        return None
    data = np.asarray(raw, dtype=np.float64)
    if len(data) % width:
        return None
    data = data.reshape(-1, width)
    mapping = str(elem.value("MappingInformationType", "ByPolygonVertex"))
    ref = str(elem.value("ReferenceInformationType", "Direct"))
    idx = None
    for k in index_keys:
        v = elem.value(k)
        if v is not None:
            idx = np.asarray(v, dtype=np.int64)
            break
    if ref in ("IndexToDirect", "Index") and idx is None:
        ref = "Direct"
    C = len(corner_verts)
    if mapping == "ByPolygonVertex":
        base = np.arange(C)
    elif mapping in ("ByVertice", "ByVertex", "ByControlPoint"):
        base = corner_verts.astype(np.int64)
    elif mapping == "ByPolygon":
        base = corner_face.astype(np.int64)
    elif mapping == "AllSame":
        base = np.zeros(C, dtype=np.int64)
    else:
        return None
    if ref in ("IndexToDirect", "Index"):
        if base.max(initial=-1) >= len(idx):
            return None
        per_corner = idx[base]
    else:
        per_corner = base
    per_corner = np.where(per_corner < 0, 0, per_corner)
    if len(data) == 0 or per_corner.max(initial=0) >= len(data):
        return None
    return IndexedAttr(data, per_corner.astype(np.int32))


def read_geometry(g: FBXNode, name: str) -> Mesh | None:
    verts = g.value("Vertices")
    pvi = g.value("PolygonVertexIndex")
    if verts is None or pvi is None or len(pvi) == 0:
        return None
    positions = np.asarray(verts, dtype=np.float64).reshape(-1, 3)
    pvi = np.asarray(pvi, dtype=np.int64)
    ends = pvi < 0
    corner_verts = np.where(ends, ~pvi, pvi).astype(np.int32)
    if not ends[-1]:
        ends[-1] = True
    end_pos = np.nonzero(ends)[0]
    face_sizes = np.diff(np.concatenate([[-1], end_pos])).astype(np.int32)
    mesh = Mesh(name, positions, face_sizes, corner_verts)
    corner_face = mesh.corner_face()

    ln = g.find("LayerElementNormal")
    if ln is not None:
        mesh.normals = _layer_index(ln, "Normals", ("NormalsIndex", "NormalIndex"), 3,
                                    corner_verts, corner_face)
    for i, lu in enumerate(g.find_all("LayerElementUV")):
        attr = _layer_index(lu, "UV", ("UVIndex",), 2, corner_verts, corner_face)
        if attr is not None:
            uvname = str(lu.value("Name", "")) or f"UVChannel_{i + 1}"
            mesh.uv_sets.append(UVSet(uvname, attr))
    lm = g.find("LayerElementMaterial")
    fm = np.zeros(mesh.num_faces, dtype=np.int32)
    if lm is not None:
        mats = lm.value("Materials")
        mapping = str(lm.value("MappingInformationType", "AllSame"))
        if mats is not None and len(mats):
            mats = np.asarray(mats, dtype=np.int32)
            if mapping == "ByPolygon" and len(mats) >= mesh.num_faces:
                fm = mats[:mesh.num_faces].copy()
            else:
                fm[:] = mats[0]
    mesh.face_material = np.maximum(fm, 0)
    ls = g.find("LayerElementSmoothing")
    if ls is not None and str(ls.value("MappingInformationType", "")) == "ByPolygon":
        sm = ls.value("Smoothing")
        if sm is not None and len(sm) == mesh.num_faces:
            mesh.smoothing = np.asarray(sm, dtype=np.int32)
    if mesh.normals is None:
        mesh.compute_flat_normals()
    return mesh


# --------------------------------------------------------------------------- #
class _TextureResolver:
    def __init__(self, fbx_path: Path) -> None:
        self.dir = fbx_path.parent
        self.media_dir = Path(tempfile.gettempdir()) / "d5bridge_media" / hashlib.md5(
            str(fbx_path).encode()).hexdigest()[:10]

    def resolve(self, filename: str, relname: str, content: bytes | None) -> str:
        cands: list[Path] = []
        for name in (relname, filename):
            if not name:
                continue
            p = Path(name.replace("\\", "/"))
            if p.is_absolute() or (len(name) > 1 and name[1] == ":"):
                cands.append(Path(name))
            else:
                cands.append(self.dir / p)
        base = Path((relname or filename).replace("\\", "/")).name
        if base:
            for sub in TEXTURE_SUBDIRS:
                cands.append((self.dir / sub / base))
        for c in cands:
            try:
                if c.is_file():
                    return str(c.resolve())
            except OSError:
                continue
        if content and base:
            self.media_dir.mkdir(parents=True, exist_ok=True)
            out = self.media_dir / base
            if not out.exists():
                out.write_bytes(content)
            return str(out)
        # last resort: case-insensitive search in the fbx folder tree (2 levels)
        if base:
            low = base.lower()
            for root, _dirs, files in os.walk(self.dir):
                if root.count(os.sep) - str(self.dir).count(os.sep) > 2:
                    continue
                for f in files:
                    if f.lower() == low:
                        return str(Path(root) / f)
        return filename or relname


def read_fbx(path: str) -> Scene:
    p = Path(path)
    tree, version = read_fbx_tree(str(p))
    scene = Scene(source_path=str(p), source_kind="fbx")

    gs = tree.find("GlobalSettings")
    if gs is not None:
        gp = _props70(gs)
        scene.unit_scale_cm = _num(gp, "UnitScaleFactor", 1.0) or 1.0
        up = int(_num(gp, "UpAxis", 1))
        scene.up_axis = "Z" if up == 2 else "Y"

    objects = tree.find("Objects")
    conns = tree.find("Connections")
    if objects is None:
        scene.warnings.append("FBX has no Objects section")
        return scene

    by_id: dict[int, FBXNode] = {}
    for o in objects.children:
        if o.props:
            by_id[o.props[0] if version >= 7000 else hash(o.props[0])] = o
    if version < 7000:
        scene.warnings.append("FBX 6.x file: limited support, re-save as FBX 2014+ if needed")

    # connections: child -> [(parent, prop)], parent -> [(child, prop)]
    children_of: dict[int, list[tuple[int, str]]] = {}
    parents_of: dict[int, list[tuple[int, str]]] = {}
    if conns is not None:
        for c in conns.children:
            if c.name not in ("C", "Connect") or len(c.props) < 3:
                continue
            kind = c.props[0]
            a, b = c.props[1], c.props[2]
            if version < 7000:
                a, b = hash(a), (0 if b == "Model::Scene" else hash(b))
            prop = str(c.props[3]) if kind == "OP" and len(c.props) > 3 else ""
            children_of.setdefault(b, []).append((a, prop))
            parents_of.setdefault(a, []).append((b, prop))

    resolver = _TextureResolver(p)
    tex_cache: dict[int, TextureRef] = {}

    def texture_ref(tid: int) -> TextureRef | None:
        if tid in tex_cache:
            return tex_cache[tid]
        t = by_id.get(tid)
        if t is None:
            return None
        if t.name == "LayeredTexture":
            for cid, _ in children_of.get(tid, []):
                r = texture_ref(cid)
                if r is not None:
                    return r
            return None
        if t.name != "Texture":
            return None
        fn = str(t.value("FileName", "") or t.value("Filename", ""))
        rel = str(t.value("RelativeFilename", ""))
        content = None
        for vid, _ in children_of.get(tid, []):
            v = by_id.get(vid)
            if v is not None and v.name == "Video":
                fn = fn or str(v.value("Filename", "") or v.value("FileName", ""))
                rel = rel or str(v.value("RelativeFilename", ""))
                c = v.value("Content")
                if isinstance(c, (bytes, Raw)) and len(c) > 0:
                    content = bytes(c)
        tp = _props70(t)
        scale = tp.get("Scaling") or [1.0, 1.0]
        trans = tp.get("Translation") or [0.0, 0.0]
        uvset = tp.get("UVSet") or [""]
        ref = TextureRef(
            path=resolver.resolve(fn, rel, content),
            uv_scale=(float(scale[0]), float(scale[1])) if len(scale) >= 2 else (1.0, 1.0),
            uv_offset=(float(trans[0]), float(trans[1])) if len(trans) >= 2 else (0.0, 0.0),
            uv_set=str(uvset[0]) if uvset and uvset[0] not in ("default", None) else "",
        )
        tex_cache[tid] = ref
        return ref

    mat_cache: dict[int, Material] = {}

    def material(mid: int) -> Material:
        if mid in mat_cache:
            return mat_cache[mid]
        m = by_id[mid]
        mp = _props70(m)
        name = _clean_name(str(m.props[1])) if len(m.props) > 1 else f"Material_{mid}"
        mat = Material(name=name, source_type=str(m.value("ShadingModel", "phong")))
        dc = mp.get("DiffuseColor") or mp.get("Diffuse") or mp.get("Maya|base_color") \
            or mp.get("3dsMax|Parameters|base_color")
        if dc and len(dc) >= 3:
            mat.base_color = tuple(float(x) for x in dc[:3])  # type: ignore[assignment]
        tf = mp.get("TransparencyFactor")
        op = mp.get("Opacity")
        if op:
            mat.opacity = float(op[0])
        elif tf:
            mat.opacity = 1.0 - float(tf[0])
        if mat.opacity <= 0.0:   # many exporters write 0 opacity with opacity map
            mat.opacity = 1.0
        for key in ("3dsMax|Parameters|roughness", "Maya|roughness"):
            if key in mp:
                mat.roughness = float(mp[key][0])
        for key in ("3dsMax|Parameters|metalness", "Maya|metallic"):
            if key in mp:
                mat.metallic = float(mp[key][0])
        if "ShininessExponent" in mp and not any(k.endswith("roughness") for k in mp):
            sh = float(mp["ShininessExponent"][0])
            mat.roughness = float(np.clip(np.sqrt(2.0 / (sh + 2.0)), 0.02, 1.0))
        if "BumpFactor" in mp:
            mat.normal_strength = mat.bump_strength = float(mp["BumpFactor"][0])
        roughness_is_gloss = "3dsMax|Parameters|roughness_inv" in mp and \
            bool(_num(mp, "3dsMax|Parameters|roughness_inv", 0))
        for cid, prop in children_of.get(mid, []):
            ref = texture_ref(cid)
            if ref is None:
                continue
            ch = channel_from_fbx_property(prop) or guess_channel_from_filename(ref.path)
            if ch is None:
                continue
            if ch == "glossiness":
                ch = "roughness"
                ref.invert = True
            elif ch == "roughness" and (roughness_is_gloss or
                                        guess_channel_from_filename(ref.path) == "glossiness"):
                ref.invert = True
            if ch == "bump" and guess_channel_from_filename(ref.path) == "normal":
                ch = "normal"
            if ch not in mat.maps:
                mat.maps[ch] = ref
        mat_cache[mid] = finalize_material(mat)
        return mat

    # ---- build models ---------------------------------------------------- #
    model_nodes: dict[int, Node] = {}
    geometry_cache: dict[int, Mesh] = {}
    for oid, o in by_id.items():
        if o.name != "Model":
            continue
        cls = str(o.props[2]) if len(o.props) > 2 else ""
        props = _props70(o)
        local, geo_off = model_local_matrix(props)
        name = _clean_name(str(o.props[1])) if len(o.props) > 1 else f"Model_{oid}"
        node = Node(name=name, local_matrix=local, uid=int(oid) & 0x7FFFFFFFFFFF)
        node.visible = bool(_num(props, "Visibility", 1.0) > 0.0) and bool(o.value("Show", True))
        node.tags["fbx_class"] = cls
        mats: list[tuple[int, Material]] = []
        for cid, _prop in children_of.get(oid, []):
            c = by_id.get(cid)
            if c is None:
                continue
            if c.name == "Geometry" and node.mesh is None:
                gname = _clean_name(str(c.props[1])) if len(c.props) > 1 else name
                mesh = geometry_cache.get(cid)
                if mesh is None:
                    mesh = read_geometry(c, gname)
                    if mesh is not None:
                        geometry_cache[cid] = mesh
                if mesh is not None:
                    if not np.allclose(geo_off, np.eye(4)):
                        mesh = _bake_offset(mesh, geo_off)
                    node.mesh = mesh
            elif c.name == "Material":
                mats.append((cid, material(cid)))
        node.materials = [m for _, m in mats]
        if node.mesh is not None and not node.materials:
            node.materials = [Material(name=f"{name}_mat")]
        if node.mesh is not None:
            hi = int(node.mesh.face_material.max(initial=0))
            while len(node.materials) <= hi:
                node.materials.append(node.materials[-1])
        model_nodes[oid] = node

    # hierarchy
    for oid, node in model_nodes.items():
        parent = None
        for pid, _ in parents_of.get(oid, []):
            if pid in model_nodes:
                parent = model_nodes[pid]
                break
        (parent or scene.root).add(node)

    return scene


def _bake_offset(mesh: Mesh, m: np.ndarray) -> Mesh:
    from ..scene import transform_normals, transform_points
    out = mesh.copy()
    out.positions = transform_points(m, out.positions)
    if out.normals is not None:
        out.normals.data = transform_normals(m, out.normals.data)
    return out
