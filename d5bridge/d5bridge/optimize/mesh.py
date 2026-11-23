"""Lossless mesh optimisation.

Every step here keeps the rendered surface bit-identical: no decimation, no
UV or normal quantisation. What it removes is pure redundancy:

* exact duplicate control points (welded only when positions are identical)
* duplicate normal / UV values (stored once, referenced by index)
* control points no face uses
* degenerate polygons (repeated corners or zero area: they render nothing)
* empty UV channels and unused material slots
* identical meshes on different objects (turned into instances)
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from ..scene import IndexedAttr, Mesh, Node


@dataclass
class MeshReport:
    vertices_before: int = 0
    vertices_after: int = 0
    faces_removed: int = 0
    normals_before: int = 0
    normals_after: int = 0
    uvs_before: int = 0
    uvs_after: int = 0
    instanced: int = 0
    notes: list[str] = field(default_factory=list)

    def merge(self, o: "MeshReport") -> None:
        for k in ("vertices_before", "vertices_after", "faces_removed", "normals_before",
                  "normals_after", "uvs_before", "uvs_after", "instanced"):
            setattr(self, k, getattr(self, k) + getattr(o, k))
        self.notes.extend(o.notes)


def _unique_rows(data: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Exact (bitwise) unique rows. Returns (unique, inverse)."""
    if len(data) == 0:
        return data, np.zeros(0, np.int32)
    d = np.ascontiguousarray(data)
    # -0.0 and +0.0 render the same; canonicalise so they merge
    d = np.where(d == 0, 0.0, d).astype(d.dtype)
    view = d.view(np.dtype((np.void, d.dtype.itemsize * d.shape[1])))
    _, first, inv = np.unique(view, return_index=True, return_inverse=True)
    # keep first-occurrence order for stable output
    order = np.argsort(first)
    remap = np.empty_like(order)
    remap[order] = np.arange(len(order))
    return d[first[order]], remap[inv.ravel()].astype(np.int32)


def dedupe_attr(attr: IndexedAttr) -> IndexedAttr:
    uniq, inv = _unique_rows(attr.data)
    return IndexedAttr(uniq, inv[attr.index].astype(np.int32))


def remove_degenerate_faces(mesh: Mesh) -> int:
    """Drop faces with fewer than 3 distinct control points or zero area."""
    sizes = mesh.face_sizes.astype(np.int64)
    if len(sizes) == 0:
        return 0
    starts = mesh.face_starts()
    cf = mesh.corner_face()
    cv = mesh.corner_verts.astype(np.int64)
    # distinct verts per face: count corners whose vertex differs from next corner
    c = np.arange(len(cv))
    nxt = starts[cf] + (c - starts[cf] + 1) % sizes[cf]
    distinct_edge = (cv != cv[nxt]).astype(np.int64)
    distinct = np.bincount(cf, weights=distinct_edge, minlength=len(sizes))
    bad = (sizes < 3) | (distinct < 3)
    # zero-area triangles/polys
    tris, tri_face = mesh.triangulate()
    if len(tris):
        p = mesh.positions[mesh.corner_verts]
        area = np.linalg.norm(np.cross(p[tris[:, 1]] - p[tris[:, 0]], p[tris[:, 2]] - p[tris[:, 0]]), axis=1)
        face_area = np.bincount(tri_face, weights=area, minlength=len(sizes))
        bad |= face_area == 0.0
    n_bad = int(bad.sum())
    if n_bad == 0:
        return 0
    keep_face = ~bad
    keep_corner = keep_face[cf]
    mesh.face_sizes = mesh.face_sizes[keep_face]
    mesh.corner_verts = mesh.corner_verts[keep_corner]
    if mesh.normals is not None:
        mesh.normals = IndexedAttr(mesh.normals.data, mesh.normals.index[keep_corner])
    for uv in mesh.uv_sets:
        uv.attr = IndexedAttr(uv.attr.data, uv.attr.index[keep_corner])
    if mesh.face_material is not None:
        mesh.face_material = mesh.face_material[keep_face]
    if mesh.smoothing is not None:
        mesh.smoothing = mesh.smoothing[keep_face]
    return n_bad


def weld_and_compact(mesh: Mesh) -> None:
    """Weld bit-identical positions and drop unreferenced control points."""
    uniq, inv = _unique_rows(mesh.positions)
    cv = inv[mesh.corner_verts]
    used = np.unique(cv)
    remap = np.full(len(uniq), -1, np.int64)
    remap[used] = np.arange(len(used))
    mesh.positions = uniq[used]
    mesh.corner_verts = remap[cv].astype(np.int32)


def compact_attr(attr: IndexedAttr) -> IndexedAttr:
    used = np.unique(attr.index)
    remap = np.full(len(attr.data), -1, np.int64)
    remap[used] = np.arange(len(used))
    return IndexedAttr(attr.data[used], remap[attr.index].astype(np.int32))


def optimize_mesh(mesh: Mesh) -> MeshReport:
    rep = MeshReport(vertices_before=mesh.num_vertices)
    rep.faces_removed = remove_degenerate_faces(mesh)
    weld_and_compact(mesh)
    rep.vertices_after = mesh.num_vertices
    if mesh.normals is not None:
        rep.normals_before = len(mesh.normals.data)
        mesh.normals = compact_attr(dedupe_attr(mesh.normals))
        rep.normals_after = len(mesh.normals.data)
    kept = []
    for uv in mesh.uv_sets:
        rep.uvs_before += len(uv.attr.data)
        a = compact_attr(dedupe_attr(uv.attr))
        if len(a.data) == 1 and kept:
            rep.notes.append(f"{mesh.name}: dropped constant UV channel '{uv.name}'")
            continue
        uv.attr = a
        rep.uvs_after += len(a.data)
        kept.append(uv)
    # identical extra UV channels (common in MaxTree: channel 1 == channel 2)
    final = []
    for uv in kept:
        if any(np.array_equal(uv.attr.expanded(), f.attr.expanded()) for f in final):
            rep.notes.append(f"{mesh.name}: dropped duplicate UV channel '{uv.name}'")
            continue
        final.append(uv)
    mesh.uv_sets = final
    return rep


def compact_material_slots(node: Node) -> None:
    """Remove material slots no face uses and merge identical slots."""
    mesh = node.mesh
    if mesh is None or mesh.face_material is None or not node.materials:
        return
    fm = np.clip(mesh.face_material, 0, len(node.materials) - 1)
    new_mats: list = []
    remap = np.zeros(len(node.materials), np.int32)
    for slot in np.unique(fm):
        m = node.materials[slot]
        for j, nm in enumerate(new_mats):
            if nm is m:
                remap[slot] = j
                break
        else:
            remap[slot] = len(new_mats)
            new_mats.append(m)
    mesh.face_material = remap[fm].astype(np.int32)
    node.materials = new_mats


def instance_identical_meshes(nodes: list[Node]) -> int:
    """Point nodes with identical geometry at one shared Mesh object."""
    by_hash: dict[str, object] = {}
    count = 0
    for n in nodes:
        if n.mesh is None:
            continue
        h = n.mesh.content_hash()
        shared = by_hash.get(h)
        if shared is None:
            by_hash[h] = n.mesh
        elif shared is not n.mesh:
            n.mesh = shared  # type: ignore[assignment]
            count += 1
    return count


def optimize_nodes(nodes: list[Node], instancing: bool = True) -> MeshReport:
    total = MeshReport()
    done: set[int] = set()
    refs: dict[int, int] = {}
    for n in nodes:
        if n.mesh is not None:
            refs[id(n.mesh)] = refs.get(id(n.mesh), 0) + 1
    for n in nodes:
        # a shared mesh keeps its slot layout: other instances depend on it
        if n.mesh is not None and refs[id(n.mesh)] == 1:
            compact_material_slots(n)
    for n in nodes:
        if n.mesh is None or id(n.mesh) in done:
            continue
        done.add(id(n.mesh))
        total.merge(optimize_mesh(n.mesh))
    if instancing:
        total.instanced = instance_identical_meshes(nodes)
    return total
