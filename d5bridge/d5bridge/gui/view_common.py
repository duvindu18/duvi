"""Renderer-independent viewport parts: camera, layout, mesh preparation, picking.

Mesh preparation (de-indexing corners into GPU vertices, triangulation,
sorting by material) is pure numpy and runs in the loader thread, so the
UI thread only uploads finished buffers.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from PIL import Image
from PySide6.QtCore import QPoint, Qt

from ..scene import Mesh, Node, Scene

PREVIEW_TEX_MAX = 2048     # preview only; exports always keep full resolution


# --------------------------------------------------------------------------- #
def perspective(fovy: float, aspect: float, near: float, far: float) -> np.ndarray:
    f = 1.0 / math.tan(math.radians(fovy) / 2)
    m = np.zeros((4, 4))
    m[0, 0] = f / aspect
    m[1, 1] = f
    m[2, 2] = (far + near) / (near - far)
    m[2, 3] = 2 * far * near / (near - far)
    m[3, 2] = -1
    return m


def look_at(eye: np.ndarray, target: np.ndarray, up=np.array([0.0, 1.0, 0.0])) -> np.ndarray:
    f = target - eye
    f = f / (np.linalg.norm(f) + 1e-12)
    s = np.cross(f, up)
    s = s / (np.linalg.norm(s) + 1e-12)
    u = np.cross(s, f)
    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = s, u, -f
    m[:3, 3] = -m[:3, :3] @ eye
    return m


def load_preview_image(path: str, extract: str = "", flip: bool = False) -> np.ndarray | None:
    """RGBA8 array for the preview (downscaled to PREVIEW_TEX_MAX)."""
    try:
        im = Image.open(path)
        im.draft("RGB", (PREVIEW_TEX_MAX, PREVIEW_TEX_MAX))   # fast JPEG downscale on decode
        im.load()
        if im.mode in ("I;16", "I;16B", "I;16L", "I"):
            a = np.asarray(im).astype(np.float32)
            im = Image.fromarray((a / max(float(a.max()), 1.0) * 255).astype(np.uint8))
        if extract and extract in "RGBA":
            im = im.convert("RGBA").getchannel(extract)
        if max(im.size) > PREVIEW_TEX_MAX:
            im.thumbnail((PREVIEW_TEX_MAX, PREVIEW_TEX_MAX), Image.BILINEAR)
        im = im.convert("RGBA")
        if flip:
            im = im.transpose(Image.FLIP_TOP_BOTTOM)
        return np.ascontiguousarray(np.asarray(im, dtype=np.uint8))
    except Exception:  # noqa: BLE001
        return None


# --------------------------------------------------------------------------- #
@dataclass
class DrawData:
    vertices: np.ndarray          # (N, 8) float32: pos, normal, uv
    indices: np.ndarray           # (T*3,) uint32, sorted by material slot
    ranges: list[tuple[int, int, int]]   # (slot, first index, index count)
    lo: np.ndarray
    hi: np.ndarray


def _unique_keys(cv: np.ndarray, ni: np.ndarray, ui: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Unique (vertex, normal, uv) corner triples -> (first corner index, inverse)."""
    a = int(cv.max(initial=0)) + 1
    b = int(ni.max(initial=0)) + 1
    c = int(ui.max(initial=0)) + 1
    if a * b * c < 2 ** 62:
        key = (cv * b + ni) * c + ui
        _, first, inv = np.unique(key, return_index=True, return_inverse=True)
        return first, inv.ravel()
    stack = np.ascontiguousarray(np.stack([cv, ni, ui], axis=1).astype(np.int64))
    view = stack.view(np.dtype((np.void, 24))).ravel()
    _, first, inv = np.unique(view, return_index=True, return_inverse=True)
    return first, inv.ravel()


def draw_data(mesh: Mesh) -> DrawData:
    cached = getattr(mesh, "_draw", None)
    if cached is not None:
        return cached
    tris, tri_face = mesh.triangulate()
    cv = mesh.corner_verts.astype(np.int64)
    ni = mesh.normals.index.astype(np.int64) if mesh.normals is not None else np.zeros_like(cv)
    ui = mesh.uv_sets[0].attr.index.astype(np.int64) if mesh.uv_sets else np.zeros_like(cv)
    if len(cv) <= 24_000_000:
        # one GPU vertex per polygon corner: no sort needed, ~10x faster to build
        first = np.arange(len(cv))
        inv = first
    else:
        first, inv = _unique_keys(cv, ni, ui)     # very large meshes: share vertices
    verts = np.empty((len(first), 8), np.float32)
    verts[:, 0:3] = mesh.positions[cv[first]]
    verts[:, 3:6] = mesh.normals.data[ni[first]] if mesh.normals is not None else (0, 0, 1)
    verts[:, 6:8] = mesh.uv_sets[0].attr.data[ui[first]] if mesh.uv_sets else 0
    idx = inv[tris].astype(np.uint32) if len(tris) else np.zeros((0, 3), np.uint32)
    fm = mesh.face_material if mesh.face_material is not None else np.zeros(mesh.num_faces, np.int32)
    tri_mat = fm[tri_face] if len(tri_face) else np.zeros(0, np.int32)
    order = np.argsort(tri_mat, kind="stable")
    idx, tri_mat = idx[order], tri_mat[order]
    ranges: list[tuple[int, int, int]] = []
    if len(tri_mat):
        slots, starts, counts = np.unique(tri_mat, return_index=True, return_counts=True)
        ranges = [(int(s), int(st) * 3, int(n) * 3) for s, st, n in zip(slots, starts, counts)]
    pos32 = verts[:, 0:3]
    lo, hi = (pos32.min(0), pos32.max(0)) if len(pos32) else (np.zeros(3), np.zeros(3))
    dd = DrawData(np.ascontiguousarray(verts), np.ascontiguousarray(idx.ravel()), ranges,
                  lo.astype(np.float64), hi.astype(np.float64))
    try:
        mesh._draw = dd          # type: ignore[attr-defined]
    except AttributeError:
        pass
    return dd


def prepare_scene(scene: Scene, progress=None) -> None:
    """Pre-compute draw data for every unique mesh (call from a worker thread)."""
    meshes = {id(n.mesh): n.mesh for n in scene.mesh_nodes() if n.mesh is not None}
    for i, m in enumerate(meshes.values()):
        draw_data(m)
        if progress and (i % 8 == 0):
            progress(f"Preparing preview {i + 1}/{len(meshes)}")


def ray_hit(dd: DrawData, origin: np.ndarray, direction: np.ndarray) -> float | None:
    """Nearest hit distance of a ray with the mesh (Moller-Trumbore, vectorised)."""
    # slab test against the mesh bounds first
    with np.errstate(divide="ignore", invalid="ignore"):
        inv = 1.0 / np.where(direction == 0, 1e-30, direction)
        t1, t2 = (dd.lo - origin) * inv, (dd.hi - origin) * inv
    tmin = np.max(np.minimum(t1, t2))
    tmax = np.min(np.maximum(t1, t2))
    if tmax < max(tmin, 0.0) or len(dd.indices) == 0:
        return None
    tri = dd.vertices[:, 0:3].astype(np.float64)[dd.indices.reshape(-1, 3)]
    v0 = tri[:, 0]
    e1 = tri[:, 1] - v0
    e2 = tri[:, 2] - v0
    p = np.cross(direction, e2)
    det = np.einsum("ij,ij->i", e1, p)
    ok = np.abs(det) > 1e-12
    inv_det = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = origin - v0
    uu = np.einsum("ij,ij->i", s, p) * inv_det
    q = np.cross(s, e1)
    vv = (q @ direction) * inv_det
    t = np.einsum("ij,ij->i", e2, q) * inv_det
    hit = ok & (uu >= 0) & (vv >= 0) & (uu + vv <= 1) & (t > 1e-9)
    if not np.any(hit):
        return None
    return float(t[hit].min())


# --------------------------------------------------------------------------- #
class OrbitCameraMixin:
    """Camera, layout and input shared by the Direct3D/RHI and OpenGL viewports."""

    def _init_camera(self) -> None:
        self.scene: Scene | None = None
        self.visible_nodes: list[Node] = []
        self.selected: set[int] = set()
        self.mode = "textured"
        self.wire = False
        self.spread = False
        self.show_grid = True
        self.bg = ((0.09, 0.09, 0.10), (0.05, 0.05, 0.055))
        self.select_col = (0.96, 0.77, 0.09)
        self.grid_col = (0.5, 0.5, 0.55)
        self._offsets: dict[int, np.ndarray] = {}
        self.yaw, self.pitch, self.dist = 35.0, 18.0, 10.0
        self.target = np.zeros(3)
        self._extent = 10.0
        self._last = QPoint()
        self._press = QPoint()
        self._btn = Qt.NoButton
        self._model_cache: dict[int, np.ndarray] = {}

    # ---- public API ---------------------------------------------------- #
    def set_theme(self, top: str, bottom: str, accent: str, grid: str) -> None:
        def c(h: str) -> tuple[float, float, float]:
            h = h.lstrip("#")
            return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]
        self.bg = (c(top), c(bottom))
        self.select_col = c(accent)
        self.grid_col = c(grid)
        self.update()

    def set_visible(self, nodes: list[Node]) -> None:
        self.visible_nodes = nodes
        self._compute_offsets()
        self.update()

    def set_selected(self, ids: set[int]) -> None:
        self.selected = set(ids)
        self.update()

    def set_spread(self, on: bool) -> None:
        self.spread = on
        self._compute_offsets()
        self.frame(all_nodes=True)

    def triangle_count(self) -> int:
        return sum(n.mesh.num_triangles for n in self.visible_nodes if n.mesh is not None)

    # ---- transforms ---------------------------------------------------- #
    def _up_fix(self) -> np.ndarray:
        if self.scene is not None and self.scene.up_axis == "Z":
            return np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], float)
        return np.eye(4)

    def _compute_offsets(self) -> None:
        self._offsets.clear()
        self._model_cache.clear()
        if not self.spread or self.scene is None or len(self.scene.variants) < 2:
            return
        fix = self._up_fix()
        placed = []
        x = 0.0
        for v in self.scene.variants:
            nodes = [n for n in v.mesh_nodes() if n.mesh is not None and n.mesh.num_vertices]
            if not nodes:
                continue
            lo, hi = self.scene.world_bounds(nodes)
            corners = np.array([[a, b, c, 1] for a in (lo[0], hi[0]) for b in (lo[1], hi[1]) for c in (lo[2], hi[2])])
            w = (fix @ corners.T).T[:, :3]
            wlo, whi = w.min(0), w.max(0)
            placed.append((nodes, x - float(wlo[0]), -float(wlo[2] + whi[2]) / 2))
            x += float(whi[0] - wlo[0]) * 1.25 + 1e-3
        mid = x / 2
        for nodes, ox, oz in placed:
            for n in nodes:
                self._offsets[id(n)] = np.array([ox - mid, 0.0, oz])

    def _model(self, n: Node) -> np.ndarray:
        m = self._model_cache.get(id(n))
        if m is None:
            m = self._up_fix() @ n.world_matrix()
            off = self._offsets.get(id(n))
            if off is not None:
                t = np.eye(4)
                t[:3, 3] = off
                m = t @ m
            self._model_cache[id(n)] = m
        return m

    def _bounds(self, nodes: list[Node]) -> tuple[np.ndarray, np.ndarray] | None:
        lo = np.full(3, np.inf)
        hi = np.full(3, -np.inf)
        for n in nodes:
            if n.mesh is None or n.mesh.num_vertices == 0:
                continue
            dd = draw_data(n.mesh)
            a, b = dd.lo, dd.hi
            corners = np.array([[x, y, z, 1] for x in (a[0], b[0]) for y in (a[1], b[1]) for z in (a[2], b[2])])
            w = (self._model(n) @ corners.T).T[:, :3]
            lo = np.minimum(lo, w.min(0))
            hi = np.maximum(hi, w.max(0))
        if not np.all(np.isfinite(lo)):
            return None
        return lo, hi

    def frame(self, all_nodes: bool = False) -> None:
        nodes = self.visible_nodes
        if not all_nodes and self.selected:
            nodes = [n for n in self.visible_nodes if id(n) in self.selected] or nodes
        b = self._bounds(nodes)
        if b is None:
            self.target, self.dist = np.zeros(3), 10.0
        else:
            lo, hi = b
            self.target = (lo + hi) / 2
            r = float(np.linalg.norm(hi - lo)) / 2 or 1.0
            self.dist = r / math.tan(math.radians(22)) * 1.05
            if all_nodes:
                self._extent = r * 4
        self.update()

    def _camera(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        w, h = max(self.width(), 1), max(self.height(), 1)
        yaw, pitch = math.radians(self.yaw), math.radians(self.pitch)
        eye = self.target + self.dist * np.array([math.cos(pitch) * math.sin(yaw), math.sin(pitch),
                                                  math.cos(pitch) * math.cos(yaw)])
        near = max(self.dist * 0.002, 1e-4)
        far = self.dist * 50 + self._extent * 4
        return perspective(40.0, w / h, near, far), look_at(eye, self.target), eye

    # ---- picking (CPU ray cast: no GPU read-back, works on every API) ----- #
    def pick_at(self, x: int, y: int) -> Node | None:
        proj, view, eye = self._camera()
        w, h = max(self.width(), 1), max(self.height(), 1)
        ndc = np.array([2 * x / w - 1, 1 - 2 * y / h, 1.0, 1.0])
        inv = np.linalg.inv(proj @ view)
        far = inv @ ndc
        far = far[:3] / far[3]
        d = far - eye
        d /= np.linalg.norm(d)
        best, best_t = None, np.inf
        for n in self.visible_nodes:
            if n.mesh is None:
                continue
            m = self._model(n)
            mi = np.linalg.inv(m)
            o_l = (mi @ np.append(eye, 1.0))[:3]
            d_l = mi[:3, :3] @ d
            t = ray_hit(draw_data(n.mesh), o_l, d_l)
            if t is None:
                continue
            world = (m @ np.append(o_l + d_l * t, 1.0))[:3]
            dist = float(np.linalg.norm(world - eye))
            if dist < best_t:
                best, best_t = n, dist
        return best

    # ---- input ------------------------------------------------------------ #
    def mousePressEvent(self, e) -> None:
        self._last = e.position().toPoint()
        self._press = self._last
        self._btn = e.button()

    def mouseReleaseEvent(self, e) -> None:
        p = e.position().toPoint()
        if e.button() == Qt.LeftButton and (p - self._press).manhattanLength() < 4:
            node = self.pick_at(p.x(), p.y())
            self.picked.emit(node, bool(e.modifiers() & (Qt.ControlModifier | Qt.ShiftModifier)))
        self._btn = Qt.NoButton

    def mouseMoveEvent(self, e) -> None:
        p = e.position().toPoint()
        d = p - self._last
        self._last = p
        if self._btn == Qt.LeftButton and not (e.modifiers() & Qt.ShiftModifier):
            self.yaw -= d.x() * 0.4
            self.pitch = max(-89.0, min(89.0, self.pitch + d.y() * 0.4))
        elif self._btn in (Qt.MiddleButton, Qt.LeftButton, Qt.RightButton):
            if self._btn == Qt.RightButton:
                self.dist *= math.exp(d.y() * 0.01)
            else:
                _, view, _ = self._camera()
                k = self.dist * 0.0015
                self.target = self.target - view[0, :3] * d.x() * k + view[1, :3] * d.y() * k
        self.update()

    def wheelEvent(self, e) -> None:
        self.dist *= math.exp(-e.angleDelta().y() / 600.0)
        self.update()

    def keyPressEvent(self, e) -> None:
        if e.key() == Qt.Key_F:
            self.frame()
        elif e.key() == Qt.Key_A:
            self.frame(all_nodes=True)
        else:
            super().keyPressEvent(e)
