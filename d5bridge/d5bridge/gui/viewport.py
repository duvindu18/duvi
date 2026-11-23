"""OpenGL 3.3 textured preview with picking.

* Base colour, opacity cut-out (leaves), normal maps (derivative-based TBN, so
  no tangents are needed), roughness, two-sided foliage lighting.
* Orbit: left drag. Pan: middle drag or Shift+left. Zoom: wheel.
  F = frame selection, A = frame all. Click = select, Ctrl+click = add.
* Display modes: textured, clay, wireframe overlay. Variants can be spread
  side by side for comparison (preview only, export keeps real positions).
"""
from __future__ import annotations

import ctypes
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from OpenGL import GL
from PIL import Image
from PySide6.QtCore import QPoint, Qt, QTimer, Signal
from PySide6.QtGui import QSurfaceFormat
from PySide6.QtOpenGLWidgets import QOpenGLWidget

from ..scene import Material, Mesh, Node, Scene, Variant

PREVIEW_TEX_MAX = 2048     # preview only; exports always keep full resolution

VS = """
#version 330 core
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec2 a_uv;
uniform mat4 u_model, u_view, u_proj;
uniform mat3 u_nmat;
out vec3 v_wpos; out vec3 v_nrm; out vec2 v_uv;
void main(){
  vec4 w = u_model * vec4(a_pos, 1.0);
  v_wpos = w.xyz; v_nrm = normalize(u_nmat * a_nrm); v_uv = a_uv;
  gl_Position = u_proj * u_view * w;
}
"""

FS = """
#version 330 core
in vec3 v_wpos; in vec3 v_nrm; in vec2 v_uv;
uniform vec3 u_cam;
uniform vec3 u_base; uniform float u_rough; uniform float u_metal; uniform float u_opacity;
uniform sampler2D t_base, t_op, t_nrm, t_rough;
uniform int u_has_base, u_has_op, u_has_nrm, u_has_rough, u_base_alpha, u_rough_inv;
uniform int u_flip_g, u_two_sided, u_clay, u_selected, u_foliage;
uniform vec4 u_uvx_base, u_uvx_op, u_uvx_nrm, u_uvx_rough;
uniform vec3 u_select_col;
uniform int u_pick; uniform vec3 u_pick_col;
out vec4 frag;

vec2 xf(vec4 t){ return v_uv * t.xy + t.zw; }

mat3 cotangent(vec3 N, vec3 p, vec2 uv){
  vec3 dp1 = dFdx(p), dp2 = dFdy(p);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * du1.x + dp1perp * du2.x;
  vec3 B = dp2perp * du1.y + dp1perp * du2.y;
  float inv = inversesqrt(max(dot(T,T), dot(B,B)) + 1e-20);
  return mat3(T * inv, B * inv, N);
}

void main(){
  float alpha = u_opacity;
  vec4 bc = vec4(u_base, 1.0);
  if (u_has_base == 1 && u_clay == 0) bc = texture(t_base, xf(u_uvx_base));
  if (u_has_op == 1) alpha *= texture(t_op, xf(u_uvx_op)).r;
  else if (u_base_alpha == 1 && u_has_base == 1) alpha *= bc.a;
  if (alpha < 0.5) discard;
  if (u_pick == 1) { frag = vec4(u_pick_col, 1.0); return; }

  vec3 N = normalize(v_nrm);
  vec3 V = normalize(u_cam - v_wpos);
  bool back = !gl_FrontFacing;
  if (back) N = -N;
  if (u_has_nrm == 1 && u_clay == 0) {
    vec3 t = texture(t_nrm, xf(u_uvx_nrm)).xyz * 2.0 - 1.0;
    if (u_flip_g == 1) t.y = -t.y;    /* DirectX (Y-) -> OpenGL (Y+) for this TBN */
    mat3 TBN = cotangent(N, v_wpos, v_uv);
    N = normalize(TBN * t);
  }
  float rough = u_rough;
  if (u_has_rough == 1 && u_clay == 0) {
    rough = texture(t_rough, xf(u_uvx_rough)).r;
    if (u_rough_inv == 1) rough = 1.0 - rough;
  }
  vec3 albedo = u_clay == 1 ? vec3(0.72) : pow(bc.rgb, vec3(2.2));
  vec3 L = normalize(vec3(0.45, 0.85, 0.35));
  vec3 H = normalize(L + V);
  float ndl = dot(N, L);
  float diff = max(ndl, 0.0);
  float trans = (u_foliage == 1 && u_clay == 0) ? max(-ndl, 0.0) * 0.45 : 0.0;
  float sky = 0.5 + 0.5 * N.y;
  vec3 amb = mix(vec3(0.20, 0.19, 0.18), vec3(0.42, 0.45, 0.50), sky);
  float a2 = max(rough * rough, 0.02);
  float spec = pow(max(dot(N, H), 0.0), 2.0 / (a2 * a2) - 1.0) * (1.0 - rough) * 0.6;
  vec3 col = albedo * (amb + diff * vec3(1.05, 1.0, 0.95) + trans * vec3(1.0, 1.0, 0.6));
  col += spec * mix(vec3(0.04), albedo, u_metal) * diff;
  if (u_selected == 1) {
    float rim = pow(1.0 - max(dot(N, V), 0.0), 2.0);
    col = mix(col, u_select_col, 0.18 + 0.55 * rim);
  }
  col = col / (col + vec3(0.85)) * 1.6;
  frag = vec4(pow(col, vec3(1.0/2.2)), 1.0);
}
"""

GRID_VS = """
#version 330 core
layout(location=0) in vec3 a_pos;
uniform mat4 u_view, u_proj;
out vec3 v_p;
void main(){ v_p = a_pos; gl_Position = u_proj * u_view * vec4(a_pos, 1.0); }
"""
GRID_FS = """
#version 330 core
in vec3 v_p; uniform vec3 u_col; uniform float u_extent;
out vec4 frag;
void main(){ float f = 1.0 - smoothstep(0.2 * u_extent, u_extent, length(v_p.xz));
  frag = vec4(u_col, 0.35 * f); }
"""

WIRE_FS = """
#version 330 core
uniform vec3 u_col; out vec4 frag;
void main(){ frag = vec4(u_col, 0.35); }
"""


def _compile(vs: str, fs: str) -> int:
    prog = GL.glCreateProgram()
    for src, kind in ((vs, GL.GL_VERTEX_SHADER), (fs, GL.GL_FRAGMENT_SHADER)):
        sh = GL.glCreateShader(kind)
        GL.glShaderSource(sh, src)
        GL.glCompileShader(sh)
        if not GL.glGetShaderiv(sh, GL.GL_COMPILE_STATUS):
            raise RuntimeError(GL.glGetShaderInfoLog(sh).decode())
        GL.glAttachShader(prog, sh)
    GL.glLinkProgram(prog)
    if not GL.glGetProgramiv(prog, GL.GL_LINK_STATUS):
        raise RuntimeError(GL.glGetProgramInfoLog(prog).decode())
    return prog


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
    f /= np.linalg.norm(f) + 1e-12
    s = np.cross(f, up)
    s /= np.linalg.norm(s) + 1e-12
    u = np.cross(s, f)
    m = np.eye(4)
    m[0, :3], m[1, :3], m[2, :3] = s, u, -f
    m[:3, 3] = -m[:3, :3] @ eye
    return m


# --------------------------------------------------------------------------- #
class GpuMesh:
    """Indexed GPU buffers for one Mesh, with one draw range per material slot."""

    def __init__(self, mesh: Mesh) -> None:
        tris, tri_face = mesh.triangulate()
        cv = mesh.corner_verts.astype(np.int64)
        ni = mesh.normals.index.astype(np.int64) if mesh.normals is not None else np.zeros_like(cv)
        ui = mesh.uv_sets[0].attr.index.astype(np.int64) if mesh.uv_sets else np.zeros_like(cv)
        key = np.stack([cv, ni, ui], axis=1)
        uniq, inv = np.unique(key, axis=0, return_inverse=True)
        inv = inv.ravel()
        pos = mesh.positions[uniq[:, 0]].astype(np.float32)
        nrm = (mesh.normals.data[uniq[:, 1]] if mesh.normals is not None
               else np.tile([0, 0, 1.0], (len(uniq), 1))).astype(np.float32)
        uv = (mesh.uv_sets[0].attr.data[uniq[:, 2]] if mesh.uv_sets
              else np.zeros((len(uniq), 2))).astype(np.float32)
        idx = inv[tris].astype(np.uint32) if len(tris) else np.zeros((0, 3), np.uint32)
        fm = mesh.face_material if mesh.face_material is not None else np.zeros(mesh.num_faces, np.int32)
        tri_mat = fm[tri_face] if len(tri_face) else np.zeros(0, np.int32)
        order = np.argsort(tri_mat, kind="stable")
        idx = idx[order]
        tri_mat = tri_mat[order]
        self.ranges: list[tuple[int, int, int]] = []   # (slot, first index, count)
        if len(tri_mat):
            slots, starts, counts = np.unique(tri_mat, return_index=True, return_counts=True)
            self.ranges = [(int(s), int(st) * 3, int(c) * 3) for s, st, c in zip(slots, starts, counts)]
        inter = np.hstack([pos, nrm, uv]).astype(np.float32)
        self.vao = GL.glGenVertexArrays(1)
        GL.glBindVertexArray(self.vao)
        self.vbo = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self.vbo)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, inter.nbytes, inter, GL.GL_STATIC_DRAW)
        stride = 8 * 4
        for loc, size, off in ((0, 3, 0), (1, 3, 12), (2, 2, 24)):
            GL.glEnableVertexAttribArray(loc)
            GL.glVertexAttribPointer(loc, size, GL.GL_FLOAT, GL.GL_FALSE, stride, ctypes.c_void_p(off))
        self.ebo = GL.glGenBuffers(1)
        GL.glBindBuffer(GL.GL_ELEMENT_ARRAY_BUFFER, self.ebo)
        flat = np.ascontiguousarray(idx.ravel())
        GL.glBufferData(GL.GL_ELEMENT_ARRAY_BUFFER, flat.nbytes, flat, GL.GL_STATIC_DRAW)
        GL.glBindVertexArray(0)
        self.tri_count = len(idx)

    def delete(self) -> None:
        GL.glDeleteBuffers(2, [self.vbo, self.ebo])
        GL.glDeleteVertexArrays(1, [self.vao])


def _load_preview_image(path: str, extract: str = "") -> tuple[str, np.ndarray | None]:
    try:
        im = Image.open(path)
        im.load()
        if im.mode in ("I;16", "I;16B", "I;16L", "I"):
            a = np.asarray(im).astype(np.float32)
            im = Image.fromarray((a / max(a.max(), 1) * 255).astype(np.uint8))
        if extract and extract in "RGBA":
            im = im.convert("RGBA")
            im = im.getchannel(extract)
        im = im.convert("RGBA")
        if max(im.size) > PREVIEW_TEX_MAX:
            im.thumbnail((PREVIEW_TEX_MAX, PREVIEW_TEX_MAX), Image.LANCZOS)
        a = np.asarray(im.transpose(Image.FLIP_TOP_BOTTOM), dtype=np.uint8)
        return path, np.ascontiguousarray(a)
    except Exception:  # noqa: BLE001
        return path, None


# --------------------------------------------------------------------------- #
class Viewport(QOpenGLWidget):
    picked = Signal(object, bool)      # Node | None, additive
    status = Signal(str)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumSize(320, 240)
        self.setFocusPolicy(Qt.StrongFocus)
        self.scene: Scene | None = None
        self.visible_nodes: list[Node] = []
        self.selected: set[int] = set()
        self.mode = "textured"            # textured | clay
        self.wire = False
        self.spread = False
        self.show_grid = True
        self.bg = ((0.09, 0.09, 0.10), (0.05, 0.05, 0.055))
        self.select_col = (0.96, 0.77, 0.09)
        self.grid_col = (0.5, 0.5, 0.55)
        self._gpu: dict[int, GpuMesh] = {}
        self._tex: dict[str, int] = {}
        self._tex_pending: set[str] = set()
        self._pool = ThreadPoolExecutor(max_workers=4)
        self._loaded: list[tuple[str, np.ndarray | None]] = []
        self._offsets: dict[int, np.ndarray] = {}
        self._pick_ids: dict[int, Node] = {}
        self.yaw, self.pitch, self.dist = 35.0, 18.0, 10.0
        self.target = np.zeros(3)
        self._last = QPoint()
        self._press = QPoint()
        self._btn = Qt.NoButton
        self.prog = self.grid_prog = self.wire_prog = 0
        self._ready = False
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._poll_textures)
        self._timer.start(60)
        self._extent = 10.0

    # ------------------------------------------------------------------ #
    @staticmethod
    def configure_default_format() -> None:
        fmt = QSurfaceFormat()
        fmt.setVersion(3, 3)
        fmt.setProfile(QSurfaceFormat.CoreProfile)
        fmt.setDepthBufferSize(24)
        fmt.setSamples(4)
        QSurfaceFormat.setDefaultFormat(fmt)

    def set_theme(self, top: str, bottom: str, accent: str, grid: str) -> None:
        def c(h: str) -> tuple[float, float, float]:
            h = h.lstrip("#")
            return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))  # type: ignore[return-value]
        self.bg = (c(top), c(bottom))
        self.select_col = c(accent)
        self.grid_col = c(grid)
        self.update()

    def set_scene(self, scene: Scene | None) -> None:
        self.makeCurrent()
        for g in self._gpu.values():
            g.delete()
        self._gpu.clear()
        if self._tex:
            GL.glDeleteTextures(list(self._tex.values()))
        self._tex.clear()
        self._tex_pending.clear()
        self.doneCurrent()
        self.scene = scene
        self.selected.clear()
        self.visible_nodes = scene.mesh_nodes() if scene else []
        self._compute_offsets()
        self.frame(all_nodes=True)
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

    # ------------------------------------------------------------------ #
    def _up_fix(self) -> np.ndarray:
        if self.scene is not None and self.scene.up_axis == "Z":
            return np.array([[1, 0, 0, 0], [0, 0, 1, 0], [0, -1, 0, 0], [0, 0, 0, 1]], float)
        return np.eye(4)

    def _compute_offsets(self) -> None:
        """Preview-only layout: put variants side by side along X."""
        self._offsets.clear()
        if not self.spread or self.scene is None or len(self.scene.variants) < 2:
            return
        fix = self._up_fix()
        placed: list[tuple[list[Node], float, float]] = []
        x = 0.0
        for v in self.scene.variants:
            nodes = [n for n in v.mesh_nodes() if n.mesh is not None and n.mesh.num_vertices]
            if not nodes:
                continue
            lo, hi = self.scene.world_bounds(nodes)
            corners = np.array([[a, b, c, 1] for a in (lo[0], hi[0])
                                for b in (lo[1], hi[1]) for c in (lo[2], hi[2])])
            w = (fix @ corners.T).T[:, :3]
            wlo, whi = w.min(0), w.max(0)
            width = float(whi[0] - wlo[0])
            placed.append((nodes, x - float(wlo[0]), -float(wlo[2] + whi[2]) / 2))
            x += width * 1.25 + 1e-3
        mid = x / 2
        for nodes, ox, oz in placed:
            for n in nodes:
                self._offsets[id(n)] = np.array([ox - mid, 0.0, oz])

    def _model(self, n: Node) -> np.ndarray:
        m = self._up_fix() @ n.world_matrix()
        off = self._offsets.get(id(n))
        if off is not None:
            t = np.eye(4)
            t[:3, 3] = off
            m = t @ m
        return m

    def _bounds(self, nodes: list[Node]) -> tuple[np.ndarray, np.ndarray] | None:
        lo = np.full(3, np.inf)
        hi = np.full(3, -np.inf)
        for n in nodes:
            if n.mesh is None or n.mesh.num_vertices == 0:
                continue
            a, b = n.mesh.bounds()
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
            self.target = np.zeros(3)
            self.dist = 10.0
        else:
            lo, hi = b
            self.target = (lo + hi) / 2
            r = float(np.linalg.norm(hi - lo)) / 2 or 1.0
            self.dist = r / math.tan(math.radians(22)) * 1.05
            if all_nodes:
                self._extent = r * 4
        self.update()

    # ------------------------------------------------------------------ #
    def initializeGL(self) -> None:
        try:
            self.prog = _compile(VS, FS)
            self.grid_prog = _compile(GRID_VS, GRID_FS)
            self.wire_prog = _compile(VS, WIRE_FS)
            self._ready = True
        except Exception as e:  # noqa: BLE001
            self.status.emit(f"OpenGL 3.3 not available: {e}")
            self._ready = False
            return
        self._grid_vao = GL.glGenVertexArrays(1)
        self._grid_vbo = GL.glGenBuffers(1)
        self._white = self._make_tex(np.full((1, 1, 4), 255, np.uint8))

    def _make_tex(self, a: np.ndarray) -> int:
        t = GL.glGenTextures(1)
        GL.glBindTexture(GL.GL_TEXTURE_2D, t)
        GL.glPixelStorei(GL.GL_UNPACK_ALIGNMENT, 1)
        GL.glTexImage2D(GL.GL_TEXTURE_2D, 0, GL.GL_RGBA8, a.shape[1], a.shape[0], 0, GL.GL_RGBA,
                        GL.GL_UNSIGNED_BYTE, a)
        GL.glGenerateMipmap(GL.GL_TEXTURE_2D)
        GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_MIN_FILTER, GL.GL_LINEAR_MIPMAP_LINEAR)
        GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_MAG_FILTER, GL.GL_LINEAR)
        GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_WRAP_S, GL.GL_REPEAT)
        GL.glTexParameteri(GL.GL_TEXTURE_2D, GL.GL_TEXTURE_WRAP_T, GL.GL_REPEAT)
        try:
            GL.glTexParameterf(GL.GL_TEXTURE_2D, 0x84FE, 8.0)   # anisotropic, if supported
        except Exception:  # noqa: BLE001
            pass
        return int(t)

    def _texture(self, path: str, extract: str = "") -> int | None:
        key = path + "|" + extract
        if key in self._tex:
            return self._tex[key] or None
        if key not in self._tex_pending:
            self._tex_pending.add(key)
            fut = self._pool.submit(_load_preview_image, path, extract)
            fut.add_done_callback(lambda f, k=key: self._loaded.append((k, f.result()[1])))
        return None

    def _poll_textures(self) -> None:
        if not self._loaded:
            return
        self.makeCurrent()
        while self._loaded:
            key, arr = self._loaded.pop()
            self._tex_pending.discard(key)
            self._tex[key] = self._make_tex(arr) if arr is not None else 0
        self.doneCurrent()
        self.update()

    def _gpu_mesh(self, mesh: Mesh) -> GpuMesh:
        g = self._gpu.get(id(mesh))
        if g is None:
            g = GpuMesh(mesh)
            self._gpu[id(mesh)] = g
        return g

    def invalidate_mesh(self, mesh: Mesh) -> None:
        g = self._gpu.pop(id(mesh), None)
        if g is not None:
            self.makeCurrent()
            g.delete()
            self.doneCurrent()
        self.update()

    # ------------------------------------------------------------------ #
    def _matrices(self) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        w, h = max(self.width(), 1), max(self.height(), 1)
        yaw, pitch = math.radians(self.yaw), math.radians(self.pitch)
        eye = self.target + self.dist * np.array([math.cos(pitch) * math.sin(yaw), math.sin(pitch),
                                                  math.cos(pitch) * math.cos(yaw)])
        near = max(self.dist * 0.002, 1e-4)
        far = self.dist * 50 + self._extent * 4
        return perspective(40.0, w / h, near, far), look_at(eye, self.target), eye

    def _draw_meshes(self, prog: int, proj, view, eye, pick: bool = False) -> None:
        GL.glUseProgram(prog)
        loc = lambda n: GL.glGetUniformLocation(prog, n)  # noqa: E731
        GL.glUniformMatrix4fv(loc("u_proj"), 1, GL.GL_TRUE, proj.astype(np.float32))
        GL.glUniformMatrix4fv(loc("u_view"), 1, GL.GL_TRUE, view.astype(np.float32))
        if prog == self.prog:
            GL.glUniform3f(loc("u_cam"), *eye)
            GL.glUniform3f(loc("u_select_col"), *self.select_col)
            GL.glUniform1i(loc("u_clay"), int(self.mode == "clay"))
            GL.glUniform1i(loc("u_pick"), int(pick))
            for i, name in enumerate(("t_base", "t_op", "t_nrm", "t_rough")):
                GL.glUniform1i(loc(name), i)
        self._pick_ids.clear()
        for k, n in enumerate(self.visible_nodes):
            if n.mesh is None:
                continue
            g = self._gpu_mesh(n.mesh)
            model = self._model(n)
            nmat = np.linalg.inv(model[:3, :3]).T
            GL.glUniformMatrix4fv(loc("u_model"), 1, GL.GL_TRUE, model.astype(np.float32))
            if prog != self.wire_prog:
                GL.glUniformMatrix3fv(loc("u_nmat"), 1, GL.GL_TRUE, nmat.astype(np.float32))
            if pick:
                pid = k + 1
                self._pick_ids[pid] = n
                GL.glUniform3f(loc("u_pick_col"), (pid & 255) / 255.0, ((pid >> 8) & 255) / 255.0,
                               ((pid >> 16) & 255) / 255.0)
            elif prog == self.prog:
                GL.glUniform1i(loc("u_selected"), int(id(n) in self.selected))
            elif prog == self.wire_prog:
                GL.glUniform3f(loc("u_col"), *self.select_col if id(n) in self.selected else self.grid_col)
            GL.glBindVertexArray(g.vao)
            for slot, first, count in g.ranges:
                if prog == self.prog:
                    mat = n.materials[min(slot, len(n.materials) - 1)] if n.materials else None
                    self._bind_material(prog, mat)
                GL.glDrawElements(GL.GL_TRIANGLES, count, GL.GL_UNSIGNED_INT, ctypes.c_void_p(first * 4))
        GL.glBindVertexArray(0)

    def _bind_material(self, prog: int, mat: Material | None) -> None:
        loc = lambda n: GL.glGetUniformLocation(prog, n)  # noqa: E731
        m = mat or Material("default")
        GL.glUniform3f(loc("u_base"), *[float(x) for x in m.base_color])
        GL.glUniform1f(loc("u_rough"), float(m.roughness))
        GL.glUniform1f(loc("u_metal"), float(m.metallic))
        GL.glUniform1f(loc("u_opacity"), 1.0)
        GL.glUniform1i(loc("u_foliage"), int(m.is_foliage))
        GL.glUniform1i(loc("u_flip_g"), int(m.normal_convention == "directx"))
        slots = (("base_color", "u_has_base", "u_uvx_base"), ("opacity", "u_has_op", "u_uvx_op"),
                 ("normal", "u_has_nrm", "u_uvx_nrm"), ("roughness", "u_has_rough", "u_uvx_rough"))
        for unit, (ch, flag, uvx) in enumerate(slots):
            ref = m.maps.get(ch)
            tex = self._texture(ref.path, ref.channel if ch == "opacity" else "") if ref and ref.path else None
            GL.glActiveTexture(GL.GL_TEXTURE0 + unit)
            GL.glBindTexture(GL.GL_TEXTURE_2D, tex or self._white)
            GL.glUniform1i(loc(flag), int(tex is not None))
            if ref:
                GL.glUniform4f(loc(uvx), ref.uv_scale[0], ref.uv_scale[1], ref.uv_offset[0], ref.uv_offset[1])
            else:
                GL.glUniform4f(loc(uvx), 1, 1, 0, 0)
        rref = m.maps.get("roughness")
        GL.glUniform1i(loc("u_rough_inv"), int(bool(rref and rref.invert)))
        GL.glUniform1i(loc("u_base_alpha"), int(m.is_foliage or "opacity" in m.maps))
        GL.glUniform1i(loc("u_two_sided"), int(m.two_sided))

    def _draw_grid(self, proj, view) -> None:
        e = self._extent
        b = self._bounds(self.visible_nodes)
        y = b[0][1] if b is not None else 0.0
        step = 10 ** math.floor(math.log10(max(e / 10, 1e-6)))
        n = int(e / step)
        lines = []
        for i in range(-n, n + 1):
            lines += [[i * step, y, -n * step], [i * step, y, n * step],
                      [-n * step, y, i * step], [n * step, y, i * step]]
        arr = np.asarray(lines, np.float32)
        GL.glUseProgram(self.grid_prog)
        GL.glUniformMatrix4fv(GL.glGetUniformLocation(self.grid_prog, "u_proj"), 1, GL.GL_TRUE, proj.astype(np.float32))
        GL.glUniformMatrix4fv(GL.glGetUniformLocation(self.grid_prog, "u_view"), 1, GL.GL_TRUE, view.astype(np.float32))
        GL.glUniform3f(GL.glGetUniformLocation(self.grid_prog, "u_col"), *self.grid_col)
        GL.glUniform1f(GL.glGetUniformLocation(self.grid_prog, "u_extent"), float(n * step))
        GL.glBindVertexArray(self._grid_vao)
        GL.glBindBuffer(GL.GL_ARRAY_BUFFER, self._grid_vbo)
        GL.glBufferData(GL.GL_ARRAY_BUFFER, arr.nbytes, arr, GL.GL_DYNAMIC_DRAW)
        GL.glEnableVertexAttribArray(0)
        GL.glVertexAttribPointer(0, 3, GL.GL_FLOAT, GL.GL_FALSE, 12, ctypes.c_void_p(0))
        GL.glDrawArrays(GL.GL_LINES, 0, len(arr))
        GL.glBindVertexArray(0)

    def paintGL(self) -> None:
        top, bottom = self.bg
        GL.glClearColor(*[(a + b) / 2 for a, b in zip(top, bottom)], 1.0)
        GL.glClear(GL.GL_COLOR_BUFFER_BIT | GL.GL_DEPTH_BUFFER_BIT)
        if not self._ready:
            return
        GL.glEnable(GL.GL_DEPTH_TEST)
        GL.glDisable(GL.GL_CULL_FACE)
        GL.glEnable(GL.GL_MULTISAMPLE)
        proj, view, eye = self._matrices()
        if self.show_grid:
            GL.glEnable(GL.GL_BLEND)
            GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE_MINUS_SRC_ALPHA)
            GL.glDepthMask(GL.GL_FALSE)
            self._draw_grid(proj, view)
            GL.glDepthMask(GL.GL_TRUE)
            GL.glDisable(GL.GL_BLEND)
        try:
            self._draw_meshes(self.prog, proj, view, eye)
            if self.wire:
                GL.glEnable(GL.GL_BLEND)
                GL.glBlendFunc(GL.GL_SRC_ALPHA, GL.GL_ONE_MINUS_SRC_ALPHA)
                GL.glPolygonMode(GL.GL_FRONT_AND_BACK, GL.GL_LINE)
                GL.glEnable(GL.GL_POLYGON_OFFSET_LINE)
                GL.glPolygonOffset(-1, -1)
                self._draw_meshes(self.wire_prog, proj, view, eye)
                GL.glPolygonMode(GL.GL_FRONT_AND_BACK, GL.GL_FILL)
                GL.glDisable(GL.GL_BLEND)
        except Exception as e:  # noqa: BLE001
            self.status.emit(f"Draw error: {e}")

    # ------------------------------------------------------------------ #
    def pick_at(self, x: int, y: int) -> Node | None:
        if not self._ready:
            return None
        self.makeCurrent()
        dpr = self.devicePixelRatioF()
        w, h = int(self.width() * dpr), int(self.height() * dpr)
        fbo = GL.glGenFramebuffers(1)
        GL.glBindFramebuffer(GL.GL_FRAMEBUFFER, fbo)
        rb = GL.glGenRenderbuffers(2)
        GL.glBindRenderbuffer(GL.GL_RENDERBUFFER, rb[0])
        GL.glRenderbufferStorage(GL.GL_RENDERBUFFER, GL.GL_RGBA8, w, h)
        GL.glFramebufferRenderbuffer(GL.GL_FRAMEBUFFER, GL.GL_COLOR_ATTACHMENT0, GL.GL_RENDERBUFFER, rb[0])
        GL.glBindRenderbuffer(GL.GL_RENDERBUFFER, rb[1])
        GL.glRenderbufferStorage(GL.GL_RENDERBUFFER, GL.GL_DEPTH_COMPONENT24, w, h)
        GL.glFramebufferRenderbuffer(GL.GL_FRAMEBUFFER, GL.GL_DEPTH_ATTACHMENT, GL.GL_RENDERBUFFER, rb[1])
        GL.glViewport(0, 0, w, h)
        GL.glClearColor(0, 0, 0, 1)
        GL.glClear(GL.GL_COLOR_BUFFER_BIT | GL.GL_DEPTH_BUFFER_BIT)
        GL.glEnable(GL.GL_DEPTH_TEST)
        GL.glDisable(GL.GL_MULTISAMPLE)
        proj, view, eye = self._matrices()
        self._draw_meshes(self.prog, proj, view, eye, pick=True)
        px = GL.glReadPixels(int(x * dpr), int(h - y * dpr - 1), 1, 1, GL.GL_RGBA, GL.GL_UNSIGNED_BYTE)
        GL.glBindFramebuffer(GL.GL_FRAMEBUFFER, self.defaultFramebufferObject())
        GL.glDeleteRenderbuffers(2, rb)
        GL.glDeleteFramebuffers(1, [fbo])
        self.doneCurrent()
        b = np.frombuffer(px, np.uint8) if isinstance(px, (bytes, bytearray)) else np.asarray(px, np.uint8).ravel()
        pid = int(b[0]) | (int(b[1]) << 8) | (int(b[2]) << 16)
        return self._pick_ids.get(pid)

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
                _, view, _ = self._matrices()
                right, up = view[0, :3], view[1, :3]
                k = self.dist * 0.0015
                self.target = self.target - right * d.x() * k + up * d.y() * k
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

    def triangle_count(self) -> int:
        return sum(n.mesh.num_triangles for n in self.visible_nodes if n.mesh is not None)
