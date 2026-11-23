"""Scene -> binary FBX 7.4 for D5 Render.

* Geometry: n-gons kept, per-corner normals and UVs stored IndexToDirect
  (each distinct value once), arrays zlib-compressed. Both are lossless.
* Meshes shared by several nodes are written once (FBX instancing).
* Materials are written as FBX Phong surfaces, the material type every FBX
  importer understands. PBR maps are connected to the slots D5 / the FBX SDK
  read: DiffuseColor (base colour, optionally with opacity in alpha),
  TransparentColor (opacity), NormalMap, Bump, EmissiveColor and AmbientColor
  (AO). Roughness and metallic maps go to the PBR properties Roughness and
  Metalness (Phong has no slot for them; Shininess would mean gloss).
"""
from __future__ import annotations

import datetime as _dt
import itertools
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from ..scene import Material, Mesh, Node, Scene, decompose_trs
from .binary import FILE_ID, TIME_ID, FBXNode, Prop, Raw, write_fbx_tree

CREATOR = "D5 Bridge FBX Exporter"

# channel -> FBX Phong property it is connected to
SLOT_FOR_CHANNEL = {
    "base_color": "DiffuseColor",
    "opacity": "TransparentColor",
    "normal": "NormalMap",
    "bump": "Bump",
    "roughness": "Roughness",          # PBR property (Shininess means gloss)
    "metallic": "Metalness",
    "emissive": "EmissiveColor",
    "ao": "AmbientColor",
    "specular": "SpecularColor",
}


@dataclass
class FBXWriteOptions:
    embed_media: bool = False
    compress_arrays: bool = True
    indexed_normals: bool = True       # IndexToDirect normals (smaller, lossless)
    write_edges: bool = True
    instancing: bool = True
    texture_rel_root: str = ""         # folder texture paths are relative to (fbx dir)


# --------------------------------------------------------------------------- #
def _p(parent: FBXNode, name: str, ptype: str, label: str, flags: str, *vals) -> None:
    parent.add("P", name, ptype, label, flags, *vals)


def _p_int(pp: FBXNode, name: str, v: int, ptype: str = "int", label: str = "Integer") -> None:
    _p(pp, name, ptype, label, "", Prop("I", int(v)))


def _p_bool(pp: FBXNode, name: str, v: bool) -> None:
    _p(pp, name, "bool", "", "", Prop("I", int(bool(v))))


def _p_enum(pp: FBXNode, name: str, v: int) -> None:
    _p(pp, name, "enum", "", "", Prop("I", int(v)))


def _p_double(pp: FBXNode, name: str, v: float, anim: bool = False) -> None:
    _p(pp, name, "double", "Number", "A" if anim else "", float(v))


def _p_num(pp: FBXNode, name: str, v: float) -> None:
    _p(pp, name, "Number", "", "A", float(v))


def _p_vec(pp: FBXNode, name: str, v, ptype: str = "Vector3D", label: str = "Vector", flags: str = "") -> None:
    _p(pp, name, ptype, label, flags, float(v[0]), float(v[1]), float(v[2]))


def _p_color(pp: FBXNode, name: str, v) -> None:
    _p(pp, name, "Color", "", "A", float(v[0]), float(v[1]), float(v[2]))


def _p_str(pp: FBXNode, name: str, v: str, ptype: str = "KString", label: str = "") -> None:
    _p(pp, name, ptype, label, "", v)


def _p_time(pp: FBXNode, name: str, v: int) -> None:
    _p(pp, name, "KTime", "Time", "", Prop("L", int(v)))


def _fbx_name(name: str, cls: str) -> str:
    return f"{name}\x00\x01{cls}"


# --------------------------------------------------------------------------- #
def _polygon_vertex_index(mesh: Mesh) -> np.ndarray:
    pvi = mesh.corner_verts.astype(np.int32).copy()
    ends = np.cumsum(mesh.face_sizes.astype(np.int64)) - 1
    pvi[ends] = ~pvi[ends]
    return pvi


def _edges(mesh: Mesh) -> np.ndarray:
    sizes = mesh.face_sizes.astype(np.int64)
    starts = mesh.face_starts()
    cf = np.repeat(np.arange(len(sizes)), sizes)
    c = np.arange(mesh.num_corners)
    nxt = starts[cf] + (c - starts[cf] + 1) % sizes[cf]
    a = mesh.corner_verts[c].astype(np.int64)
    b = mesh.corner_verts[nxt].astype(np.int64)
    key = np.minimum(a, b) * (mesh.num_vertices + 1) + np.maximum(a, b)
    _, first = np.unique(key, return_index=True)
    return np.sort(first).astype(np.int32)


def _geometry_node(objects: FBXNode, gid: int, mesh: Mesh, opts: FBXWriteOptions) -> None:
    g = objects.add("Geometry", Prop("L", gid), _fbx_name(mesh.name, "Geometry"), "Mesh")
    g.add("Properties70")
    g.add("GeometryVersion", Prop("I", 124))
    g.add("Vertices", np.ascontiguousarray(mesh.positions, dtype=np.float64).ravel())
    g.add("PolygonVertexIndex", _polygon_vertex_index(mesh))
    if opts.write_edges and mesh.num_corners:
        g.add("Edges", _edges(mesh))

    layer_elems: list[tuple[str, int]] = []
    if mesh.normals is not None:
        ln = g.add("LayerElementNormal", Prop("I", 0))
        ln.add("Version", Prop("I", 102))
        ln.add("Name", "")
        ln.add("MappingInformationType", "ByPolygonVertex")
        if opts.indexed_normals:
            ln.add("ReferenceInformationType", "IndexToDirect")
            ln.add("Normals", np.ascontiguousarray(mesh.normals.data, dtype=np.float64).ravel())
            ln.add("NormalsIndex", mesh.normals.index.astype(np.int32))
        else:
            ln.add("ReferenceInformationType", "Direct")
            ln.add("Normals", np.ascontiguousarray(mesh.normals.expanded(), dtype=np.float64).ravel())
        layer_elems.append(("LayerElementNormal", 0))

    if mesh.smoothing is not None and len(mesh.smoothing) == mesh.num_faces:
        ls = g.add("LayerElementSmoothing", Prop("I", 0))
        ls.add("Version", Prop("I", 102))
        ls.add("Name", "")
        ls.add("MappingInformationType", "ByPolygon")
        ls.add("ReferenceInformationType", "Direct")
        ls.add("Smoothing", mesh.smoothing.astype(np.int32))
        layer_elems.append(("LayerElementSmoothing", 0))

    for i, uv in enumerate(mesh.uv_sets):
        lu = g.add("LayerElementUV", Prop("I", i))
        lu.add("Version", Prop("I", 101))
        lu.add("Name", uv.name or f"UVChannel_{i + 1}")
        lu.add("MappingInformationType", "ByPolygonVertex")
        lu.add("ReferenceInformationType", "IndexToDirect")
        lu.add("UV", np.ascontiguousarray(uv.attr.data, dtype=np.float64).ravel())
        lu.add("UVIndex", uv.attr.index.astype(np.int32))

    lm = g.add("LayerElementMaterial", Prop("I", 0))
    lm.add("Version", Prop("I", 101))
    lm.add("Name", "")
    fm = mesh.face_material if mesh.face_material is not None else np.zeros(mesh.num_faces, np.int32)
    if len(fm) == 0 or np.all(fm == fm[0]):
        lm.add("MappingInformationType", "AllSame")
        lm.add("ReferenceInformationType", "IndexToDirect")
        lm.add("Materials", np.array([int(fm[0]) if len(fm) else 0], dtype=np.int32))
    else:
        lm.add("MappingInformationType", "ByPolygon")
        lm.add("ReferenceInformationType", "IndexToDirect")
        lm.add("Materials", fm.astype(np.int32))
    layer_elems.append(("LayerElementMaterial", 0))

    layer = g.add("Layer", Prop("I", 0))
    layer.add("Version", Prop("I", 100))
    for typ, idx in layer_elems:
        le = layer.add("LayerElement")
        le.add("Type", typ)
        le.add("TypedIndex", Prop("I", idx))
    if mesh.uv_sets:
        le = layer.add("LayerElement")
        le.add("Type", "LayerElementUV")
        le.add("TypedIndex", Prop("I", 0))
    for i in range(1, len(mesh.uv_sets)):
        lay = g.add("Layer", Prop("I", i))
        lay.add("Version", Prop("I", 100))
        le = lay.add("LayerElement")
        le.add("Type", "LayerElementUV")
        le.add("TypedIndex", Prop("I", i))


def _model_node(objects: FBXNode, mid: int, node: Node, matrix: np.ndarray) -> None:
    cls = "Mesh" if node.mesh is not None else "Null"
    m = objects.add("Model", Prop("L", mid), _fbx_name(node.name, "Model"), cls)
    m.add("Version", Prop("I", 232))
    pp = m.add("Properties70")
    t, r, s = decompose_trs(matrix)
    _p_bool(pp, "RotationActive", True)
    _p_enum(pp, "InheritType", 1)
    _p_vec(pp, "ScalingMax", (0, 0, 0))
    if node.mesh is not None:
        _p_int(pp, "DefaultAttributeIndex", 0)
    _p_vec(pp, "Lcl Translation", t, "Lcl Translation", "", "A")
    _p_vec(pp, "Lcl Rotation", r, "Lcl Rotation", "", "A")
    _p_vec(pp, "Lcl Scaling", s, "Lcl Scaling", "", "A")
    if not node.visible:
        _p(pp, "Visibility", "Visibility", "", "A", 0.0)
    m.add("MultiLayer", Prop("I", 0))
    m.add("MultiTake", Prop("I", 0))
    m.add("Shading", True)
    m.add("Culling", "CullingOff")


def _material_node(objects: FBXNode, mid: int, mat: Material, channels: dict[str, str]) -> None:
    m = objects.add("Material", Prop("L", mid), _fbx_name(mat.name, "Material"), "")
    m.add("Version", Prop("I", 102))
    m.add("ShadingModel", "phong")
    m.add("MultiLayer", Prop("I", 0))
    pp = m.add("Properties70")
    _p_str(pp, "ShadingModel", "Phong")
    _p_color(pp, "EmissiveColor", mat.emissive)
    _p_num(pp, "EmissiveFactor", 1.0 if (any(mat.emissive) or "emissive" in channels) else 0.0)
    _p_color(pp, "AmbientColor", (0.0, 0.0, 0.0))
    _p_num(pp, "AmbientFactor", 1.0)
    base = (1.0, 1.0, 1.0) if "base_color" in channels else mat.base_color
    _p_color(pp, "DiffuseColor", base)
    _p_num(pp, "DiffuseFactor", 1.0)
    has_op = "opacity" in channels
    _p_color(pp, "TransparentColor", (1.0, 1.0, 1.0) if has_op else (0.0, 0.0, 0.0))
    _p_num(pp, "TransparencyFactor", 1.0 if has_op else 1.0 - mat.opacity)
    _p_double(pp, "Opacity", mat.opacity)
    _p_num(pp, "BumpFactor", mat.normal_strength if "normal" in channels else mat.bump_strength)
    spec = 0.5 * (1.0 - mat.roughness)
    _p_color(pp, "SpecularColor", (spec, spec, spec))
    _p_num(pp, "SpecularFactor", 1.0)
    shin = max(2.0 / max(mat.roughness, 0.02) ** 2 - 2.0, 0.0)
    _p_num(pp, "ShininessExponent", min(shin, 1024.0))
    _p_num(pp, "Shininess", min(shin, 1024.0))
    _p_color(pp, "ReflectionColor", (1.0, 1.0, 1.0))
    _p_num(pp, "ReflectionFactor", mat.metallic)
    # Physically-based hints some importers (incl. D5) look for
    _p_double(pp, "Roughness", mat.roughness)
    _p_double(pp, "Metalness", mat.metallic)
    _p_bool(pp, "TwoSided", mat.two_sided)


def _texture_nodes(objects: FBXNode, tid: int, vid: int, name: str, path: str,
                   rel: str, embed: bool, uv_scale, uv_offset, uv_set: str,
                   alpha_source: str) -> None:
    t = objects.add("Texture", Prop("L", tid), _fbx_name(name, "Texture"), "")
    t.add("Type", "TextureVideoClip")
    t.add("Version", Prop("I", 202))
    t.add("TextureName", _fbx_name(name, "Texture"))
    pp = t.add("Properties70")
    _p_bool(pp, "UseMaterial", True)
    if uv_set:
        _p_str(pp, "UVSet", uv_set)
    if tuple(uv_scale) != (1.0, 1.0):
        _p_vec(pp, "Scaling", (uv_scale[0], uv_scale[1], 1.0), "Vector", "", "A")
    if tuple(uv_offset) != (0.0, 0.0):
        _p_vec(pp, "Translation", (uv_offset[0], uv_offset[1], 0.0), "Vector", "", "A")
    t.add("Media", _fbx_name(name, "Video"))
    t.add("FileName", path)
    t.add("RelativeFilename", rel)
    t.add("ModelUVTranslation", 0.0, 0.0)
    t.add("ModelUVScaling", 1.0, 1.0)
    t.add("Texture_Alpha_Source", alpha_source)
    t.add("Cropping", Prop("I", 0), Prop("I", 0), Prop("I", 0), Prop("I", 0))

    v = objects.add("Video", Prop("L", vid), _fbx_name(name, "Video"), "Clip")
    v.add("Type", "Clip")
    vp = v.add("Properties70")
    _p_str(vp, "Path", path, "KString", "XRefUrl")
    _p_str(vp, "RelPath", rel, "KString", "XRefUrl")
    v.add("UseMipMap", Prop("I", 0))
    v.add("Filename", path)
    v.add("RelativeFilename", rel)
    if embed and os.path.isfile(path):
        v.add("Content", Raw(Path(path).read_bytes()))
    else:
        v.add("Content", Raw(b""))


# --------------------------------------------------------------------------- #
def write_fbx(path: str, scene: Scene, roots: list[Node],
              texture_paths: dict[int, dict[str, str]] | None = None,
              opts: FBXWriteOptions | None = None,
              base_alpha: set[int] | None = None) -> int:
    """Write ``roots`` (and their sub-trees) to ``path``.

    ``texture_paths`` maps ``id(material) -> {channel: output file}``; when it
    is None the material's own map paths are used. ``base_alpha`` holds
    ``id(material)`` of materials whose base-colour texture carries opacity in
    its alpha channel. Returns the file size in bytes.
    """
    opts = opts or FBXWriteOptions()
    out_dir = Path(path).resolve().parent
    rel_root = Path(opts.texture_rel_root).resolve() if opts.texture_rel_root else out_dir
    base_alpha = base_alpha or set()
    ids = itertools.count(1_000_000_000 + (os.getpid() % 1000) * 1_000_000)

    root = FBXNode("")
    _header(root, scene)

    objects = FBXNode("Objects")
    conns = FBXNode("Connections")
    counts = {"Model": 0, "Geometry": 0, "Material": 0, "Texture": 0, "Video": 0}

    geom_ids: dict[int, int] = {}
    mat_ids: dict[int, int] = {}
    tex_ids: dict[tuple[str, str], int] = {}

    def add_conn(kind: str, child: int, parent: int, prop: str | None = None) -> None:
        if prop is None:
            conns.add("C", kind, Prop("L", child), Prop("L", parent))
        else:
            conns.add("C", kind, Prop("L", child), Prop("L", parent), prop)

    def material_id(mat: Material) -> int:
        key = id(mat)
        if key in mat_ids:
            return mat_ids[key]
        mid = next(ids)
        mat_ids[key] = mid
        chans = (texture_paths or {}).get(key)
        if chans is None:
            chans = {ch: ref.path for ch, ref in mat.maps.items() if ref.path}
        chans = {ch: p for ch, p in chans.items() if ch in SLOT_FOR_CHANNEL and p}
        _material_node(objects, mid, mat, chans)
        counts["Material"] += 1
        for ch, tex_path in chans.items():
            ref = mat.maps.get(ch)
            slot = SLOT_FOR_CHANNEL[ch]
            tkey = (tex_path, ch)
            if tkey not in tex_ids:
                tid, vid = next(ids), next(ids)
                tex_ids[tkey] = tid
                abs_path = str(Path(tex_path).resolve())
                try:
                    rel = os.path.relpath(abs_path, rel_root)
                except ValueError:       # different drive on Windows
                    rel = abs_path
                alpha = "Alpha_Black" if (ch == "base_color" and key in base_alpha) else "None"
                _texture_nodes(objects, tid, vid, f"{mat.name}_{ch}", abs_path,
                               rel.replace("/", "\\"), opts.embed_media,
                               ref.uv_scale if ref else (1.0, 1.0),
                               ref.uv_offset if ref else (0.0, 0.0),
                               ref.uv_set if ref else "", alpha)
                add_conn("OO", vid, tid)
                counts["Texture"] += 1
                counts["Video"] += 1
            add_conn("OP", tex_ids[tkey], mid, slot)
            if ch == "base_color" and key in base_alpha and "opacity" not in chans:
                add_conn("OP", tex_ids[tkey], mid, "TransparentColor")
        return mid

    def emit(node: Node, parent_id: int, matrix: np.ndarray) -> None:
        nid = next(ids)
        _model_node(objects, nid, node, matrix)
        counts["Model"] += 1
        add_conn("OO", nid, parent_id)
        if node.mesh is not None:
            gkey = id(node.mesh) if opts.instancing else id(node)
            if gkey not in geom_ids:
                geom_ids[gkey] = next(ids)
                _geometry_node(objects, geom_ids[gkey], node.mesh, opts)
                counts["Geometry"] += 1
            add_conn("OO", geom_ids[gkey], nid)
            for mat in node.materials:
                add_conn("OO", material_id(mat), nid)
        for c in node.children:
            emit(c, nid, c.local_matrix)

    for r in roots:
        # roots keep their world placement
        emit(r, 0, r.world_matrix())

    _definitions(root, counts)
    root.children.append(objects)
    root.children.append(conns)
    takes = root.add("Takes")
    takes.add("Current", "")
    return write_fbx_tree(path, root, 7400, opts.compress_arrays)


def _header(root: FBXNode, scene: Scene) -> None:
    now = _dt.datetime.now()
    he = root.add("FBXHeaderExtension")
    he.add("FBXHeaderVersion", Prop("I", 1003))
    he.add("FBXVersion", Prop("I", 7400))
    ts = he.add("CreationTimeStamp")
    for k, v in (("Version", 1000), ("Year", now.year), ("Month", now.month), ("Day", now.day),
                 ("Hour", now.hour), ("Minute", now.minute), ("Second", now.second),
                 ("Millisecond", now.microsecond // 1000)):
        ts.add(k, Prop("I", v))
    he.add("Creator", CREATOR)
    si = he.add("SceneInfo", _fbx_name("GlobalInfo", "SceneInfo"), "UserData")
    si.add("Type", "UserData")
    si.add("Version", Prop("I", 100))
    md = si.add("MetaData")
    md.add("Version", Prop("I", 100))
    for k in ("Title", "Subject", "Author", "Keywords", "Revision", "Comment"):
        md.add(k, "")
    sp = si.add("Properties70")
    src = scene.source_path or ""
    _p_str(sp, "DocumentUrl", src, "KString", "Url")
    _p_str(sp, "SrcDocumentUrl", src, "KString", "Url")
    _p(sp, "Original", "Compound", "", "")
    _p_str(sp, "Original|ApplicationVendor", "D5 Bridge")
    _p_str(sp, "Original|ApplicationName", "D5 Bridge")
    _p_str(sp, "Original|ApplicationVersion", "1.0")
    _p(sp, "LastSaved", "Compound", "", "")
    _p_str(sp, "LastSaved|ApplicationVendor", "D5 Bridge")
    _p_str(sp, "LastSaved|ApplicationName", "D5 Bridge")
    _p_str(sp, "LastSaved|ApplicationVersion", "1.0")

    root.add("FileId", Raw(FILE_ID))
    root.add("CreationTime", TIME_ID.decode())
    root.add("Creator", CREATOR)

    gs = root.add("GlobalSettings")
    gs.add("Version", Prop("I", 1000))
    pp = gs.add("Properties70")
    if scene.up_axis == "Z":
        up, front, front_sign = 2, 1, -1
    else:
        up, front, front_sign = 1, 2, 1
    _p_int(pp, "UpAxis", up)
    _p_int(pp, "UpAxisSign", 1)
    _p_int(pp, "FrontAxis", front)
    _p_int(pp, "FrontAxisSign", front_sign)
    _p_int(pp, "CoordAxis", 0)
    _p_int(pp, "CoordAxisSign", 1)
    _p_int(pp, "OriginalUpAxis", up)
    _p_int(pp, "OriginalUpAxisSign", 1)
    _p_double(pp, "UnitScaleFactor", scene.unit_scale_cm)
    _p_double(pp, "OriginalUnitScaleFactor", scene.unit_scale_cm)
    _p(pp, "AmbientColor", "ColorRGB", "Color", "", 0.0, 0.0, 0.0)
    _p_str(pp, "DefaultCamera", "Producer Perspective")
    _p_enum(pp, "TimeMode", 11)
    _p_enum(pp, "TimeProtocol", 2)
    _p_enum(pp, "SnapOnFrameMode", 0)
    _p_time(pp, "TimeSpanStart", 0)
    _p_time(pp, "TimeSpanStop", 46186158000)
    _p_double(pp, "CustomFrameRate", -1.0)
    _p(pp, "TimeMarker", "Compound", "", "")
    _p_int(pp, "CurrentTimeMarker", -1)

    docs = root.add("Documents")
    docs.add("Count", Prop("I", 1))
    doc = docs.add("Document", Prop("L", 999_999_999), "Scene", "Scene")
    dp = doc.add("Properties70")
    _p(dp, "SourceObject", "object", "", "")
    _p_str(dp, "ActiveAnimStackName", "")
    doc.add("RootNode", Prop("L", 0))
    root.add("References")


def _definitions(root: FBXNode, counts: dict[str, int]) -> None:
    d = root.add("Definitions")
    d.add("Version", Prop("I", 100))
    types = [("GlobalSettings", 1)] + [(k, v) for k, v in counts.items() if v]
    d.add("Count", Prop("I", sum(v for _, v in types)))
    for name, n in types:
        ot = d.add("ObjectType", name)
        ot.add("Count", Prop("I", n))
