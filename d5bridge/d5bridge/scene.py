"""In-memory scene model shared by every importer, optimizer, viewer and exporter.

Geometry is kept in an *indexed* form that maps 1:1 onto FBX:

* ``positions``      (V, 3) float64  - control points
* ``face_sizes``     (F,)   int32    - corner count of every polygon (n-gons kept)
* ``corner_verts``   (C,)   int32    - control point used by every polygon corner
* ``normals``        IndexedAttr     - per-corner normals (data + per-corner index)
* ``uv_sets``        [UVSet]         - per-corner UVs, one entry per UV channel
* ``face_material``  (F,)   int32    - slot index into ``Node.materials``

Materials are metal/roughness PBR, which is what D5 Render works in.
"""
from __future__ import annotations

import copy
import hashlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

import numpy as np


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #
@dataclass
class IndexedAttr:
    """Per-corner attribute stored as unique values + per-corner index."""

    data: np.ndarray            # (N, k)
    index: np.ndarray           # (C,) int32 into ``data``

    def expanded(self) -> np.ndarray:
        return self.data[self.index]

    def copy(self) -> "IndexedAttr":
        return IndexedAttr(self.data.copy(), self.index.copy())


@dataclass
class UVSet:
    name: str
    attr: IndexedAttr           # data is (N, 2)


@dataclass
class Mesh:
    name: str
    positions: np.ndarray
    face_sizes: np.ndarray
    corner_verts: np.ndarray
    normals: IndexedAttr | None = None
    uv_sets: list[UVSet] = field(default_factory=list)
    face_material: np.ndarray | None = None
    smoothing: np.ndarray | None = None        # optional per-face smoothing groups

    # ------------------------------------------------------------------ #
    @property
    def num_vertices(self) -> int:
        return int(len(self.positions))

    @property
    def num_faces(self) -> int:
        return int(len(self.face_sizes))

    @property
    def num_corners(self) -> int:
        return int(len(self.corner_verts))

    @property
    def num_triangles(self) -> int:
        return int(np.sum(np.maximum(self.face_sizes - 2, 0)))

    def face_starts(self) -> np.ndarray:
        starts = np.zeros(len(self.face_sizes), dtype=np.int64)
        if len(self.face_sizes) > 1:
            np.cumsum(self.face_sizes[:-1], out=starts[1:])
        return starts

    def corner_face(self) -> np.ndarray:
        """Face index of every corner."""
        return np.repeat(np.arange(len(self.face_sizes), dtype=np.int32), self.face_sizes)

    def materials_used(self) -> np.ndarray:
        if self.face_material is None or len(self.face_material) == 0:
            return np.zeros(1, dtype=np.int32)
        return np.unique(self.face_material)

    def bounds(self) -> tuple[np.ndarray, np.ndarray]:
        if len(self.positions) == 0:
            z = np.zeros(3)
            return z, z
        return self.positions.min(axis=0), self.positions.max(axis=0)

    def copy(self) -> "Mesh":
        return copy.deepcopy(self)

    def __deepcopy__(self, memo) -> "Mesh":
        # never copy the viewport's cached GPU data (it would be stale and large)
        new = Mesh.__new__(Mesh)
        memo[id(self)] = new
        for k, v in self.__dict__.items():
            if k != "_draw":
                setattr(new, k, copy.deepcopy(v, memo))
        return new

    def content_hash(self) -> str:
        """Hash of the full geometry, used to find identical meshes (instancing)."""
        h = hashlib.blake2b(digest_size=16)
        for arr in (self.positions, self.face_sizes, self.corner_verts, self.face_material):
            if arr is not None:
                h.update(np.ascontiguousarray(arr).tobytes())
        if self.normals is not None:
            h.update(np.ascontiguousarray(self.normals.expanded()).tobytes())
        for uv in self.uv_sets:
            h.update(np.ascontiguousarray(uv.attr.expanded()).tobytes())
        return h.hexdigest()

    # ------------------------------------------------------------------ #
    def triangulate(self) -> tuple[np.ndarray, np.ndarray]:
        """Fan-triangulate. Returns (tri_corners (T,3) corner indices, tri_face (T,))."""
        sizes = self.face_sizes.astype(np.int64)
        starts = self.face_starts()
        ntri = np.maximum(sizes - 2, 0)
        total = int(ntri.sum())
        if total == 0:
            return np.zeros((0, 3), np.int64), np.zeros(0, np.int64)
        tri_face = np.repeat(np.arange(len(sizes)), ntri)
        # k-th triangle inside its face
        first_tri = np.zeros(len(sizes), np.int64)
        np.cumsum(ntri[:-1], out=first_tri[1:])
        k = np.arange(total) - first_tri[tri_face]
        base = starts[tri_face]
        tris = np.stack([base, base + k + 1, base + k + 2], axis=1)
        return tris, tri_face

    def compute_flat_normals(self) -> None:
        """Create per-face normals when a file has none."""
        tris, tri_face = self.triangulate()
        p = self.positions[self.corner_verts]
        fn = np.zeros((self.num_faces, 3))
        if len(tris):
            n = np.cross(p[tris[:, 1]] - p[tris[:, 0]], p[tris[:, 2]] - p[tris[:, 0]])
            np.add.at(fn, tri_face, n)
        ln = np.linalg.norm(fn, axis=1, keepdims=True)
        fn = np.divide(fn, ln, out=np.zeros_like(fn), where=ln > 0)
        self.normals = IndexedAttr(fn.astype(np.float64), self.corner_face().astype(np.int32))


# --------------------------------------------------------------------------- #
# Materials
# --------------------------------------------------------------------------- #
CHANNELS = (
    "base_color", "opacity", "normal", "bump", "roughness", "metallic",
    "ao", "translucency", "emissive", "displacement", "specular",
)


@dataclass
class TextureRef:
    path: str
    uv_scale: tuple[float, float] = (1.0, 1.0)
    uv_offset: tuple[float, float] = (0.0, 0.0)
    uv_set: str = ""
    invert: bool = False          # e.g. glossiness map used as roughness
    channel: str = ""             # "R", "G", "B", "A" or "" (all) when packed
    gamma: float | None = None

    def exists(self) -> bool:
        return bool(self.path) and Path(self.path).is_file()


@dataclass
class Material:
    name: str
    base_color: tuple[float, float, float] = (0.8, 0.8, 0.8)
    opacity: float = 1.0
    roughness: float = 0.5
    metallic: float = 0.0
    normal_strength: float = 1.0
    bump_strength: float = 1.0
    emissive: tuple[float, float, float] = (0.0, 0.0, 0.0)
    translucency: tuple[float, float, float] = (0.0, 0.0, 0.0)
    two_sided: bool = False
    is_foliage: bool = False
    normal_convention: str = "directx"   # "directx" (3ds Max / D5) or "opengl"
    maps: dict[str, TextureRef] = field(default_factory=dict)
    source_type: str = ""                 # e.g. CoronaPhysicalMtl, VRayMtl
    notes: list[str] = field(default_factory=list)

    def texture(self, channel: str) -> TextureRef | None:
        return self.maps.get(channel)

    def set_map(self, channel: str, ref: TextureRef | None) -> None:
        if ref is None or not ref.path:
            self.maps.pop(channel, None)
        else:
            self.maps[channel] = ref


# --------------------------------------------------------------------------- #
# Nodes / scene graph
# --------------------------------------------------------------------------- #
@dataclass
class Node:
    name: str
    local_matrix: np.ndarray = field(default_factory=lambda: np.eye(4))
    mesh: Mesh | None = None
    materials: list[Material] = field(default_factory=list)
    children: list["Node"] = field(default_factory=list)
    parent: "Node | None" = field(default=None, repr=False)
    layer: str = ""
    visible: bool = True
    uid: int = 0
    tags: dict[str, str] = field(default_factory=dict)

    def add(self, child: "Node") -> "Node":
        child.parent = self
        self.children.append(child)
        return child

    def walk(self) -> Iterator["Node"]:
        yield self
        for c in self.children:
            yield from c.walk()

    def world_matrix(self) -> np.ndarray:
        m = self.local_matrix
        p = self.parent
        while p is not None:
            m = p.local_matrix @ m
            p = p.parent
        return m

    def path(self) -> str:
        parts = []
        n: Node | None = self
        while n is not None and n.parent is not None:
            parts.append(n.name)
            n = n.parent
        return "/".join(reversed(parts))


@dataclass
class Variant:
    """A group of nodes that form one selectable asset (e.g. 'Tree A')."""

    name: str
    nodes: list[Node]
    reason: str = ""                       # how it was detected

    def mesh_nodes(self) -> list[Node]:
        out: list[Node] = []
        seen: set[int] = set()
        for root in self.nodes:
            for n in root.walk():
                if n.mesh is not None and id(n) not in seen:
                    seen.add(id(n))
                    out.append(n)
        return out


@dataclass
class Scene:
    root: Node = field(default_factory=lambda: Node("RootNode"))
    unit_scale_cm: float = 1.0        # FBX UnitScaleFactor (1 = centimetres)
    up_axis: str = "Y"                 # "Y" or "Z"
    source_path: str = ""
    source_kind: str = ""              # "fbx", "obj", "max-bundle", "megascans"
    variants: list[Variant] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def nodes(self) -> Iterator[Node]:
        for c in self.root.children:
            yield from c.walk()

    def mesh_nodes(self) -> list[Node]:
        return [n for n in self.nodes() if n.mesh is not None]

    def materials(self) -> list[Material]:
        seen: dict[int, Material] = {}
        for n in self.mesh_nodes():
            for m in n.materials:
                seen.setdefault(id(m), m)
        return list(seen.values())

    def stats(self) -> dict[str, int]:
        meshes = {id(n.mesh): n.mesh for n in self.mesh_nodes()}
        return {
            "objects": len(self.mesh_nodes()),
            "unique_meshes": len(meshes),
            "vertices": sum(m.num_vertices for m in meshes.values()),
            "triangles": sum(m.num_triangles for m in meshes.values()),
            "materials": len(self.materials()),
        }

    def world_bounds(self, nodes: list[Node] | None = None) -> tuple[np.ndarray, np.ndarray]:
        nodes = nodes if nodes is not None else self.mesh_nodes()
        lo = np.full(3, np.inf)
        hi = np.full(3, -np.inf)
        for n in nodes:
            if n.mesh is None or n.mesh.num_vertices == 0:
                continue
            a, b = node_world_bounds(n)
            lo = np.minimum(lo, a)
            hi = np.maximum(hi, b)
        if not np.all(np.isfinite(lo)):
            return np.zeros(3), np.zeros(3)
        return lo, hi


def node_world_bounds(n: Node) -> tuple[np.ndarray, np.ndarray]:
    assert n.mesh is not None
    lo, hi = n.mesh.bounds()
    corners = np.array([[x, y, z, 1.0] for x in (lo[0], hi[0])
                        for y in (lo[1], hi[1]) for z in (lo[2], hi[2])])
    w = (n.world_matrix() @ corners.T).T[:, :3]
    return w.min(axis=0), w.max(axis=0)


# --------------------------------------------------------------------------- #
# Matrix helpers (FBX conventions: column vectors, Euler in degrees)
# --------------------------------------------------------------------------- #
def _rx(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[1, 0, 0, 0], [0, c, -s, 0], [0, s, c, 0], [0, 0, 0, 1]])


def _ry(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, 0, s, 0], [0, 1, 0, 0], [-s, 0, c, 0], [0, 0, 0, 1]])


def _rz(a: float) -> np.ndarray:
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0, 0], [s, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]])


_ORDERS = {0: "XYZ", 1: "XZY", 2: "YZX", 3: "YXZ", 4: "ZXY", 5: "ZYX"}


def euler_matrix(deg: tuple[float, float, float] | np.ndarray, order: int = 0) -> np.ndarray:
    """FBX Euler rotation. Order "XYZ" means X is applied first: M = Rz @ Ry @ Rx."""
    rx, ry, rz = np.radians(np.asarray(deg, dtype=np.float64))
    mats = {"X": _rx(rx), "Y": _ry(ry), "Z": _rz(rz)}
    m = np.eye(4)
    for axis in _ORDERS.get(order, "XYZ"):
        m = mats[axis] @ m
    return m


def translation_matrix(t) -> np.ndarray:
    m = np.eye(4)
    m[:3, 3] = t
    return m


def scale_matrix(s) -> np.ndarray:
    m = np.eye(4)
    m[0, 0], m[1, 1], m[2, 2] = s
    return m


def compose_trs(t, r_deg, s) -> np.ndarray:
    return translation_matrix(t) @ euler_matrix(r_deg) @ scale_matrix(s)


def decompose_trs(m: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Decompose into translation, XYZ Euler degrees and scale (no shear)."""
    t = m[:3, 3].copy()
    a = m[:3, :3].copy()
    s = np.linalg.norm(a, axis=0)
    s[s == 0] = 1.0
    if np.linalg.det(a) < 0:
        s[0] = -s[0]
    r = a / s
    # R = Rz @ Ry @ Rx  ->  r[2,0] = -sin(y)
    sy = -r[2, 0]
    sy = max(-1.0, min(1.0, sy))
    y = np.arcsin(sy)
    if abs(np.cos(y)) > 1e-8:
        x = np.arctan2(r[2, 1], r[2, 2])
        z = np.arctan2(r[1, 0], r[0, 0])
    else:  # gimbal lock
        x = np.arctan2(-r[1, 2], r[1, 1])
        z = 0.0
    return t, np.degrees([x, y, z]), s


def transform_points(m: np.ndarray, p: np.ndarray) -> np.ndarray:
    return p @ m[:3, :3].T + m[:3, 3]


def transform_normals(m: np.ndarray, n: np.ndarray) -> np.ndarray:
    nm = np.linalg.inv(m[:3, :3]).T
    out = n @ nm.T
    ln = np.linalg.norm(out, axis=1, keepdims=True)
    return np.divide(out, ln, out=np.zeros_like(out), where=ln > 0)
