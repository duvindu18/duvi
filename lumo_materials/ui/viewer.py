"""3D material preview: OpenGL 3.3 (PBR, displacement, five light presets) with a CPU fallback."""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QImage, QMatrix4x4, QPixmap, QSurfaceFormat, QVector2D, QVector3D
from PySide6.QtOpenGL import (QOpenGLBuffer, QOpenGLShader, QOpenGLShaderProgram, QOpenGLTexture,
                              QOpenGLVertexArrayObject)
from PySide6.QtOpenGLWidgets import QOpenGLWidget
from PySide6.QtWidgets import QLabel, QStackedLayout, QWidget

from ..engine import render
from ..viewmodel import BOTH_OFFSET, PLANE_SCALE, SPHERE_SCALE, camera_distance
from . import meshes

GL_FLOAT = 0x1406
GL_TRIANGLES = 0x0004
GL_DEPTH_TEST = 0x0B71
GL_CULL_FACE = 0x0B44
GL_COLOR_BUFFER_BIT = 0x4000
GL_DEPTH_BUFFER_BIT = 0x0100
GL_MULTISAMPLE = 0x809D

LIGHTS = {  # name: label, [(dir, colour * intensity)], sky top, sky bottom, env band, exposure
    "studio":   ("Studio",   [((-0.55, 0.65, 0.55), (3.2, 3.1, 2.95)), ((0.8, 0.1, 0.4), (0.7, 0.8, 0.95)),
                              ((0.1, -0.6, 0.3), (0.3, 0.28, 0.26))], (0.55, 0.57, 0.62), (0.16, 0.15, 0.15), 0.8, 1.0),
    "softbox":  ("Softbox",  [((0.0, 0.85, 0.5), (2.6, 2.6, 2.6)), ((-0.9, 0.2, 0.3), (0.9, 0.9, 0.9)),
                              ((0.9, 0.2, 0.3), (0.9, 0.9, 0.9))], (0.7, 0.7, 0.72), (0.2, 0.2, 0.2), 1.4, 1.0),
    "window":   ("Window",   [((-0.9, 0.3, 0.3), (3.6, 3.4, 3.0)), ((0.7, 0.2, 0.6), (0.25, 0.3, 0.4)),
                              ((0.0, -1.0, 0.2), (0.1, 0.09, 0.08))], (0.45, 0.52, 0.65), (0.1, 0.09, 0.08), 0.5, 1.05),
    "overcast": ("Overcast", [((0.0, 1.0, 0.3), (1.3, 1.35, 1.45)), ((0.6, 0.4, 0.7), (0.5, 0.52, 0.55)),
                              ((-0.6, 0.4, 0.7), (0.5, 0.52, 0.55))], (0.85, 0.88, 0.92), (0.35, 0.35, 0.34), 0.2, 1.1),
    "dramatic": ("Dramatic", [((0.9, 0.35, -0.2), (5.0, 4.2, 3.2)), ((-0.7, 0.1, 0.3), (0.12, 0.16, 0.25)),
                              ((0.0, -1.0, 0.0), (0.0, 0.0, 0.0))], (0.12, 0.13, 0.16), (0.02, 0.02, 0.02), 0.3, 1.0),
}
BACKGROUNDS = {"auto": ("Auto", "#121214"), "dark": ("Dark", "#0b0b0c"), "grey": ("Grey", "#5b5b5f"),
               "white": ("White", "#f2f2f2")}
DISPLAY = [("lit", "Lit"), ("albedo", "Albedo"), ("normal", "Normal"), ("roughness", "Roughness"),
           ("metallic", "Metallic"), ("height", "Height"), ("ao", "AO")]
SHAPES = [("sphere", "Sphere"), ("plane", "Plane"), ("both", "Both")]
_MODE_INDEX = {k: i for i, (k, _) in enumerate(DISPLAY)}
_TEX_ORDER = ("albedo", "normal", "roughness", "metallic", "height", "ao")

VERT = """
#version 330 core
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUV;
layout(location = 3) in vec4 aTan;
uniform mat4 uProj; uniform mat4 uView; uniform mat4 uModel;
uniform vec2 uTiling; uniform float uDisp; uniform sampler2D tHeight;
out vec3 vPos; out vec2 vUV; out vec3 vN; out vec3 vT; out float vW;
void main() {
    vec2 uv = aUV * uTiling;
    float h = textureLod(tHeight, uv, 0.0).r;
    vec3 p = aPos + aNrm * (h - 0.5) * uDisp;
    vec4 wp = uModel * vec4(p, 1.0);
    mat3 nm = mat3(uModel);
    vPos = wp.xyz; vN = nm * aNrm; vT = nm * aTan.xyz; vW = aTan.w; vUV = uv;
    gl_Position = uProj * uView * wp;
}
"""

FRAG = """
#version 330 core
in vec3 vPos; in vec2 vUV; in vec3 vN; in vec3 vT; in float vW;
uniform sampler2D tAlbedo; uniform sampler2D tNormal; uniform sampler2D tRough;
uniform sampler2D tMetal; uniform sampler2D tHeight; uniform sampler2D tAO;
uniform vec3 uCam; uniform int uMode;
uniform vec3 uL0d; uniform vec3 uL0c; uniform vec3 uL1d; uniform vec3 uL1c; uniform vec3 uL2d; uniform vec3 uL2c;
uniform vec3 uSkyTop; uniform vec3 uSkyBot; uniform float uBand; uniform float uExposure;
out vec4 frag;
const float PI = 3.14159265;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
float ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float g1(float x, float k) { return x / (x * (1.0 - k) + k); }
vec3 fresnel(float c, vec3 f0) { return f0 + (1.0 - f0) * pow(1.0 - c, 5.0); }
vec3 env(vec3 d) {
    vec3 c = mix(uSkyBot, uSkyTop, smoothstep(-0.2, 0.9, d.y));
    float band = exp(-pow((d.y - 0.35) / 0.12, 2.0)) * uBand;
    return c + band * uSkyTop;
}
vec3 light(vec3 n, vec3 V, vec3 alb, float r, float m, vec3 f0, vec3 Ld, vec3 Lc) {
    vec3 L = normalize(Ld); vec3 H = normalize(L + V);
    float nl = max(dot(n, L), 0.0); float nv = max(dot(n, V), 1e-4);
    float nh = max(dot(n, H), 0.0); float vh = max(dot(V, H), 0.0);
    float a = r * r; float k = (r + 1.0) * (r + 1.0) / 8.0;
    vec3 F = fresnel(vh, f0);
    float spec = ggx(nh, a) * g1(nl, k) * g1(nv, k) / (4.0 * nl * nv + 1e-4);
    vec3 kd = (1.0 - F) * (1.0 - m);
    return (kd * alb / PI + F * spec) * Lc * nl;
}
void main() {
    vec4 a4 = texture(tAlbedo, vUV);
    if (uMode == 1) { frag = vec4(a4.rgb, 1.0); return; }
    if (uMode == 2) { frag = vec4(texture(tNormal, vUV).rgb, 1.0); return; }
    if (uMode == 3) { frag = vec4(vec3(texture(tRough, vUV).r), 1.0); return; }
    if (uMode == 4) { frag = vec4(vec3(texture(tMetal, vUV).r), 1.0); return; }
    if (uMode == 5) { frag = vec4(vec3(texture(tHeight, vUV).r), 1.0); return; }
    if (uMode == 6) { frag = vec4(vec3(texture(tAO, vUV).r), 1.0); return; }
    vec3 N = normalize(vN);
    vec3 T = normalize(vT - N * dot(N, vT));
    vec3 B = cross(N, T) * vW;
    vec3 tn = texture(tNormal, vUV).xyz * 2.0 - 1.0;
    vec3 n = normalize(T * tn.x + B * tn.y + N * max(tn.z, 0.05));
    vec3 alb = pow(a4.rgb, vec3(2.2));
    float r = clamp(texture(tRough, vUV).r, 0.04, 1.0);
    float m = texture(tMetal, vUV).r;
    float ao = texture(tAO, vUV).r;
    vec3 V = normalize(uCam - vPos);
    vec3 f0 = mix(vec3(0.04), alb, m);
    vec3 col = light(n, V, alb, r, m, f0, uL0d, uL0c) + light(n, V, alb, r, m, f0, uL1d, uL1c)
             + light(n, V, alb, r, m, f0, uL2d, uL2c);
    float nv = max(dot(n, V), 1e-4);
    vec3 Fr = fresnel(nv, f0) * (1.0 - r * 0.6);
    vec3 R = reflect(-V, n);
    vec3 spec = mix(env(R), 0.5 * (uSkyTop + uSkyBot), r * r) * Fr;
    vec3 diff = env(n) * alb * (1.0 - m) * (1.0 - Fr);
    col += (diff * 0.9 + spec) * ao;
    col = aces(col * uExposure);
    frag = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
"""


RENDERERS = [("auto", "Automatic (Direct3D 12 first)"), ("d3d12", "Direct3D 12"), ("d3d11", "Direct3D 11"),
             ("opengl", "OpenGL 3.3"), ("cpu", "CPU preview")]
RENDERER_LABELS = {"d3d12": "Direct3D 12", "d3d11": "Direct3D 11", "opengl": "OpenGL", "cpu": "CPU preview"}


def configure_renderer(choice: str) -> list[str]:
    """Call before QApplication is created. LUMO_RENDERER overrides the setting."""
    import os
    import sys
    from ..viewmodel import renderer_chain
    choice = os.environ.get("LUMO_RENDERER", choice or "auto")
    MaterialView.chain = renderer_chain(choice, sys.platform == "win32")
    MaterialView.choice = choice
    return MaterialView.chain


def configure_default_format() -> None:
    """Call before QApplication is created."""
    fmt = QSurfaceFormat()
    fmt.setVersion(3, 3)
    fmt.setProfile(QSurfaceFormat.OpenGLContextProfile.CoreProfile)
    fmt.setDepthBufferSize(24)
    fmt.setSamples(4)
    QSurfaceFormat.setDefaultFormat(fmt)


class _ViewState:
    def __init__(self):
        self.shape = "sphere"
        self.tiling = 2.0
        self.displacement = 0.35
        self.light = "studio"
        self.background = "auto"
        self.mode = "lit"
        self.yaw = 20.0
        self.pitch = 12.0
        self.zoom = 1.0
        self.spin = False


class GLViewer(QOpenGLWidget):
    failed = Signal(str)
    frameSubmitted = Signal()

    def __init__(self, state: _ViewState, parent=None):
        super().__init__(parent)
        self.s = state
        self.program: QOpenGLShaderProgram | None = None
        self.meshes: dict[str, tuple[QOpenGLVertexArrayObject, QOpenGLBuffer, int]] = {}
        self.textures: dict[str, QOpenGLTexture] = {}
        self._pending: dict[str, np.ndarray] | None = None
        self._ok = False
        self._drag: QPointF | None = None
        self.setMinimumSize(120, 120)
        self.setProperty("interactive", True)
        self.setCursor(Qt.CursorShape.OpenHandCursor)

    # ------------------------------------------------------------ GL lifecycle
    def initializeGL(self):
        try:
            ctx = self.context()
            fmt = ctx.format()
            try:
                f = ctx.functions()
                MaterialView.gl_info = f"{f.glGetString(0x1F01)} | OpenGL {f.glGetString(0x1F02)}"   # renderer, version
            except Exception:
                MaterialView.gl_info = f"OpenGL {fmt.majorVersion()}.{fmt.minorVersion()}"
            print(f"OpenGL context: {MaterialView.gl_info}")
            if (fmt.majorVersion(), fmt.minorVersion()) < (3, 3) or ctx.isOpenGLES():
                raise RuntimeError(f"OpenGL 3.3 is not available (got {fmt.majorVersion()}.{fmt.minorVersion()}, "
                                   f"{MaterialView.gl_info})")
            prog = QOpenGLShaderProgram(self)
            if not prog.addShaderFromSourceCode(QOpenGLShader.ShaderTypeBit.Vertex, VERT):
                raise RuntimeError(prog.log())
            if not prog.addShaderFromSourceCode(QOpenGLShader.ShaderTypeBit.Fragment, FRAG):
                raise RuntimeError(prog.log())
            if not prog.link():
                raise RuntimeError(prog.log())
            self.program = prog
            for name, data in (("sphere", meshes.sphere()), ("plane", meshes.plane())):
                self.meshes[name] = self._upload_mesh(data)
            self._ok = True
            self.device_info = f"OpenGL: {MaterialView.gl_info}"
            QTimer.singleShot(0, self.frameSubmitted.emit)
            ctx.aboutToBeDestroyed.connect(self._cleanup)
        except Exception as e:  # driver problems: switch to the CPU preview
            self._ok = False
            QTimer.singleShot(0, lambda msg=str(e): self.failed.emit(msg))

    def _upload_mesh(self, data: np.ndarray):
        vao = QOpenGLVertexArrayObject(self)
        vao.create()
        vao.bind()
        vbo = QOpenGLBuffer(QOpenGLBuffer.Type.VertexBuffer)
        vbo.create()
        vbo.bind()
        raw = data.tobytes()
        vbo.allocate(raw, len(raw))
        p = self.program
        stride = meshes.STRIDE * 4
        for loc, offset, size in ((0, 0, 3), (1, 3, 3), (2, 6, 2), (3, 8, 4)):
            p.enableAttributeArray(loc)
            p.setAttributeBuffer(loc, GL_FLOAT, offset * 4, size, stride)
        vao.release()
        vbo.release()
        return vao, vbo, data.shape[0]

    def _cleanup(self):
        self.makeCurrent()
        for t in self.textures.values():
            t.destroy()
        self.textures.clear()
        for vao, vbo, _ in self.meshes.values():
            vbo.destroy()
            vao.destroy()
        self.meshes.clear()
        self.doneCurrent()

    def set_maps(self, maps_u8: dict[str, np.ndarray]) -> None:
        self._pending = maps_u8
        self._blank = False
        self.update()

    def clear_maps(self) -> None:
        self._pending = None
        self._blank = True
        self.update()

    def _upload_textures(self) -> None:
        maps, self._pending = self._pending, None
        for t in self.textures.values():
            t.destroy()
        self.textures.clear()
        for name in _TEX_ORDER:
            a = maps.get(name)
            if a is None:
                continue
            h, w = a.shape[:2]
            if a.ndim == 3:
                img = QImage(a.tobytes(), w, h, w * 4, QImage.Format.Format_RGBA8888).copy()
            else:
                img = QImage(a.tobytes(), w, h, w, QImage.Format.Format_Grayscale8).copy()
            tex = QOpenGLTexture(img, QOpenGLTexture.MipMapGeneration.GenerateMipMaps)
            tex.setWrapMode(QOpenGLTexture.WrapMode.Repeat)
            tex.setMinificationFilter(QOpenGLTexture.Filter.LinearMipMapLinear)
            tex.setMagnificationFilter(QOpenGLTexture.Filter.Linear)
            tex.setMaximumAnisotropy(8.0)
            self.textures[name] = tex

    def paintGL(self):
        f = self.context().functions()
        bg = BACKGROUNDS.get(self.s.background, BACKGROUNDS["auto"])[1]
        c = tuple(int(bg[i:i + 2], 16) / 255 for i in (1, 3, 5))
        f.glClearColor(c[0], c[1], c[2], 1.0)
        f.glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT)
        if not self._ok or self.program is None:
            return
        if self._pending is not None:
            self._upload_textures()
        if len(self.textures) < len(_TEX_ORDER) or getattr(self, "_blank", False):
            return
        f.glEnable(GL_DEPTH_TEST)
        f.glEnable(GL_CULL_FACE)
        f.glEnable(GL_MULTISAMPLE)
        p = self.program
        p.bind()
        w, h = max(1, self.width()), max(1, self.height())
        proj = QMatrix4x4()
        both = self.s.shape == "both"
        proj.perspective(32.0, w / h, 0.1, 100.0)
        dist = camera_distance(self.s.shape, w / h, self.s.zoom)
        view = QMatrix4x4()
        cam = QVector3D(0.0, 0.0, dist)
        view.lookAt(cam, QVector3D(0, 0, 0), QVector3D(0, 1, 0))
        p.setUniformValue("uProj", proj)
        p.setUniformValue("uView", view)
        p.setUniformValue("uCam", cam)
        p.setUniformValue1i("uMode", _MODE_INDEX.get(self.s.mode, 0))
        _, lights, top, bot, band, expo = LIGHTS.get(self.s.light, LIGHTS["studio"])
        for i, (d, col) in enumerate(lights):
            p.setUniformValue(f"uL{i}d", QVector3D(*d))
            p.setUniformValue(f"uL{i}c", QVector3D(*col))
        p.setUniformValue("uSkyTop", QVector3D(*top))
        p.setUniformValue("uSkyBot", QVector3D(*bot))
        p.setUniformValue1f("uBand", float(band))
        p.setUniformValue1f("uExposure", float(expo))
        p.setUniformValue1f("uDisp", float(self.s.displacement) * 0.12)
        for unit, (name, uni) in enumerate(zip(_TEX_ORDER, ("tAlbedo", "tNormal", "tRough", "tMetal", "tHeight", "tAO"), strict=True)):
            self.textures[name].bind(unit)
            p.setUniformValue1i(uni, unit)
        items = []
        if self.s.shape in ("sphere", "both"):
            items.append(("sphere", -BOTH_OFFSET if both else 0.0))
        if self.s.shape in ("plane", "both"):
            items.append(("plane", BOTH_OFFSET if both else 0.0))
        for name, x in items:
            model = QMatrix4x4()
            model.translate(x, 0, 0)
            model.rotate(self.s.pitch, 1, 0, 0)
            model.rotate(self.s.yaw, 0, 1, 0)
            if name == "plane":
                model.scale(PLANE_SCALE["both" if both else "plane"])
                p.setUniformValue("uTiling", QVector2D(self.s.tiling, self.s.tiling))
            else:
                model.scale(SPHERE_SCALE["both" if both else "sphere"])
                # the mesh already has square texels (u 0..2 around, v 0..1 top to bottom)
                p.setUniformValue("uTiling", QVector2D(self.s.tiling * 0.5, self.s.tiling * 0.5))
            p.setUniformValue("uModel", model)
            vao, _, count = self.meshes[name]
            vao.bind()
            f.glDrawArrays(GL_TRIANGLES, 0, count)
            vao.release()
        for t in self.textures.values():
            t.release()
        p.release()

    # ------------------------------------------------------------ interaction
    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drag = e.position()
            self.setCursor(Qt.CursorShape.ClosedHandCursor)

    def mouseMoveEvent(self, e):
        if self._drag is not None:
            d = e.position() - self._drag
            self._drag = e.position()
            self.s.yaw = (self.s.yaw + d.x() * 0.5) % 360
            self.s.pitch = max(-85.0, min(85.0, self.s.pitch + d.y() * 0.4))
            self.update()

    def mouseReleaseEvent(self, e):
        self._drag = None
        self.setCursor(Qt.CursorShape.OpenHandCursor)

    def mouseDoubleClickEvent(self, e):
        self.s.yaw, self.s.pitch, self.s.zoom = 20.0, 12.0, 1.0
        self.update()

    def wheelEvent(self, e):
        self.s.zoom = max(0.5, min(3.0, self.s.zoom * (1.1 ** (e.angleDelta().y() / 120.0))))
        self.update()
        e.accept()


class CpuViewer(QLabel):
    """Fallback: the same preview rendered on the CPU (no orbit)."""

    def __init__(self, state: _ViewState, parent=None):
        super().__init__(parent)
        self.s = state
        self.maps: dict[str, np.ndarray] | None = None
        self.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.setMinimumSize(120, 120)
        self._t = QTimer(self, singleShot=True, interval=60)
        self._t.timeout.connect(self._render)

    def set_float_maps(self, maps: dict[str, np.ndarray]) -> None:
        self.maps = maps
        self._t.start()

    def refresh(self):
        self._t.start()

    def resizeEvent(self, e):
        self._t.start()
        super().resizeEvent(e)

    def _render(self):
        bg = BACKGROUNDS.get(self.s.background, BACKGROUNDS["auto"])[1]
        bgc = tuple(int(bg[i:i + 2], 16) / 255 for i in (1, 3, 5))
        if not self.maps:
            self.clear()
            return
        size = max(64, min(560, min(self.width(), self.height()) - 16))
        m = self.maps
        if self.s.mode != "lit":
            key = self.s.mode
            a = m[key]
            if a.ndim == 2:
                a = np.repeat(a[..., None], 3, axis=2)
            from ..engine.imageio import resize
            rgb = resize(a, size, size)
        elif self.s.shape == "plane":
            rgb = render.plane(m, size=size, tiles=max(1, int(round(self.s.tiling))))
        else:
            rgb = render.composite(render.sphere(m, size=size, tiles=self.s.tiling * 0.5, supersample=1), bgc)
        u8 = np.ascontiguousarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))
        img = QImage(u8.tobytes(), u8.shape[1], u8.shape[0], u8.shape[1] * 3, QImage.Format.Format_RGB888).copy()
        self.setPixmap(QPixmap.fromImage(img))
        self.setStyleSheet(f"background: {bg}; border-radius: 10px;")


class MaterialView(QWidget):
    """The viewer used everywhere. Tries the renderers in MaterialView.chain (Direct3D 12 -> Direct3D 11 ->
    OpenGL -> CPU) and moves on whenever one fails; later views start with the one that worked."""
    usingFallback = Signal(str)

    chain: list[str] = ["opengl", "cpu"]   # set by configure_renderer()
    choice = "auto"
    backend = ""                            # renderer in use (key of RENDERER_LABELS)
    device_info = ""                        # e.g. "D3D12 on NVIDIA GeForce RTX 4070"
    gl_info = ""                            # OpenGL renderer string, when OpenGL was tried

    def __init__(self, parent=None, gpu: bool = True):
        super().__init__(parent)
        self.state = _ViewState()
        self.stack = QStackedLayout(self)
        self.stack.setContentsMargins(0, 0, 0, 0)
        self.cpu = CpuViewer(self.state)
        self.stack.addWidget(self.cpu)
        self.gpu: QWidget | None = None
        self._float: dict[str, np.ndarray] | None = None
        self._u8: dict[str, np.ndarray] | None = None
        self._spin = QTimer(self, interval=16)
        self._spin.timeout.connect(self._step)
        self.setProperty("interactive", True)
        self._start(MaterialView.chain if gpu else ["cpu"])

    @property
    def gl(self):          # kept for older callers: the GPU widget, whatever its API
        return self.gpu

    def _make(self, kind: str) -> QWidget | None:
        if kind in ("d3d12", "d3d11"):
            try:
                from .rhi_viewer import RhiViewer
            except ImportError:          # PySide6 without QRhiWidget
                return None
            return RhiViewer(self.state, kind)
        if kind == "opengl":
            return GLViewer(self.state)
        return None

    def _start(self, chain: list[str]) -> None:
        for i, kind in enumerate(chain):
            w = self._make(kind) if kind != "cpu" else None
            if kind == "cpu" or w is not None:
                self._kind = kind
                self._rest = chain[i + 1:]
                break
        else:
            self._kind, self._rest, w = "cpu", [], None
        if w is not None:
            self.gpu = w
            w.failed.connect(self._failed)
            if hasattr(w, "frameSubmitted"):
                w.frameSubmitted.connect(self._worked)
            self.stack.addWidget(w)
            self.stack.setCurrentWidget(w)
        else:
            self.stack.setCurrentWidget(self.cpu)
            MaterialView.backend = "cpu"

    def _worked(self) -> None:
        if MaterialView.backend != self._kind:
            MaterialView.backend = self._kind
            MaterialView.device_info = getattr(self.gpu, "device_info", "") or RENDERER_LABELS.get(self._kind, "")
        try:
            self.gpu.frameSubmitted.disconnect(self._worked)
        except (RuntimeError, TypeError, AttributeError):
            pass

    def _failed(self, reason: str) -> None:
        print(f"Preview renderer {self._kind} failed: {reason}")
        old = self.gpu
        if old is not None:
            self.stack.removeWidget(old)
            old.hide()
            old.deleteLater()
            self.gpu = None
        rest = [k for k in self._rest]
        MaterialView.chain = rest if rest else ["cpu"]       # new views skip what failed
        self._start(MaterialView.chain)
        if self.gpu is not None:
            if self._u8 is not None:
                self.gpu.set_maps(self._u8)
        else:
            if self._float is None and self._u8 is not None:
                self._float = meshes.u8_to_float(self._u8)
            if self._float is not None:
                self.cpu.set_float_maps(self._float)
            self._spin.stop()
        self.usingFallback.emit(f"{RENDERER_LABELS.get(self._kind, self._kind)} in use; {reason}")

    def clear(self) -> None:
        """Shows nothing (never the previous material) until new maps arrive."""
        self._float = self._u8 = None
        self.cpu.clear()
        if self.gpu is not None and hasattr(self.gpu, "clear_maps"):
            self.gpu.clear_maps()

    def set_u8(self, u8_maps: dict[str, np.ndarray]) -> None:
        """Preview maps straight from Library.load_preview_u8 (no float copies needed for the GPU views)."""
        self._u8 = u8_maps
        self._float = None
        if self.gpu is not None:
            self.gpu.set_maps(u8_maps)
        else:
            self._float = meshes.u8_to_float(u8_maps)
            self.cpu.set_float_maps(self._float)

    def set_maps(self, float_maps: dict[str, np.ndarray] | None, u8_maps: dict[str, np.ndarray] | None = None):
        """float_maps: preview-sized engine maps; u8_maps: meshes.maps_to_u8(float_maps) (made in a worker)."""
        self._float = float_maps
        if float_maps is None:
            self.clear()
            return
        self._u8 = u8_maps if u8_maps is not None else meshes.maps_to_u8(float_maps)
        if self.gpu is not None:
            self.gpu.set_maps(self._u8)
        else:
            self.cpu.set_float_maps(float_maps)

    def _refresh(self):
        if self.gpu is not None:
            self.gpu.update()
        else:
            self.cpu.refresh()

    def set_option(self, key: str, value) -> None:
        setattr(self.state, key, value)
        if key == "spin":
            if value and self.gpu is not None:
                self._spin.start()
            else:
                self._spin.stop()
        self._refresh()

    def _step(self):
        self.state.yaw = (self.state.yaw + 0.35) % 360
        if self.gpu is not None:
            self.gpu.update()

    def sizeHint(self):
        return QSize(320, 260)
