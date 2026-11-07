"""Material preview through Qt's RHI: Direct3D 12 (or 11) on Windows, without any OpenGL driver.

Uses the shaders in lumo_materials/shaders, compiled to .qsb (HLSL / SPIR-V / GLSL) by
packaging/compile_shaders.py. Any failure (no .qsb, no D3D12 device, pipeline error) is reported through
`failed`, and MaterialView moves on to the next renderer.
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QByteArray, QPointF, QSize, Qt, QTimer, Signal
from PySide6.QtGui import (QColor, QImage, QRhiBuffer, QRhiDepthStencilClearValue, QRhiGraphicsPipeline,
                           QRhiSampler, QRhiShaderResourceBinding, QRhiShaderStage, QRhiTexture,
                           QRhiVertexInputAttribute, QRhiVertexInputBinding, QRhiVertexInputLayout, QRhiViewport,
                           QShader)
from PySide6.QtWidgets import QRhiWidget

from ..viewmodel import BOTH_OFFSET, PLANE_SCALE, SPHERE_SCALE, camera_distance
from . import meshes, theme

UBO_SIZE = 304           # std140 size of the Params block (see material.vert)
_TEX = ("albedo", "normal", "roughness", "metallic", "height", "ao")   # bindings 1..6
_MODE = {"lit": 0, "albedo": 1, "normal": 2, "roughness": 3, "metallic": 4, "height": 5, "ao": 6}
API_LABELS = {"d3d12": "Direct3D 12", "d3d11": "Direct3D 11"}


def _api(name: str):
    a = QRhiWidget.Api
    return {"d3d12": a.Direct3D12, "d3d11": a.Direct3D11}[name]


def _load_shader(name: str) -> QShader:
    p = theme.asset_dir() / "shaders" / f"{name}.qsb"
    if not p.exists():
        raise RuntimeError(f"compiled shader {p.name} is missing (run packaging/compile_shaders.py)")
    sh = QShader.fromSerialized(QByteArray(p.read_bytes()))
    if not sh.isValid():
        raise RuntimeError(f"{p.name} is not a valid shader pack")
    return sh


def _qmatrix_to_np(m) -> np.ndarray:
    rows = [m.row(i) for i in range(4)]
    return np.array([[r.x(), r.y(), r.z(), r.w()] for r in rows], np.float32)


class RhiViewer(QRhiWidget):
    failed = Signal(str)

    def __init__(self, state, api: str = "d3d12", parent=None):
        super().__init__(parent)
        self.s = state
        self.api_name = api
        self.setApi(_api(api))
        self.setSampleCount(4)
        self.setMinimumSize(120, 120)
        self.setProperty("interactive", True)
        self.setCursor(Qt.CursorShape.OpenHandCursor)
        self.renderFailed.connect(lambda: self._fail(f"{API_LABELS[api]} could not be started on this PC"))
        self._rhi = None
        self._ok = True
        self._pending: dict[str, np.ndarray] | None = None
        self._textures: dict[str, QRhiTexture] = {}
        self._have_maps = False
        self._last_maps: dict[str, np.ndarray] | None = None
        self._srbs: list = []
        self._layout_srb = None
        self._drag: QPointF | None = None
        self.device_info = ""

    def _fail(self, msg: str) -> None:
        if self._ok:
            self._ok = False
            QTimer.singleShot(0, lambda: self.failed.emit(msg))

    # ------------------------------------------------------------ resources
    def initialize(self, cb):
        try:
            self._initialize(cb)
        except Exception as e:  # any problem: hand over to the next renderer
            self._fail(f"{API_LABELS[self.api_name]}: {e}")

    def _initialize(self, cb):
        rhi = self.rhi()
        if rhi is None:
            raise RuntimeError("no rendering device")
        if rhi is self._rhi and getattr(self, "_pipeline", None) is not None:
            return
        self._rhi = rhi
        self._textures = {}          # resources of an earlier device are not valid on this one
        self._srbs = []
        self._layout_srb = None
        try:
            info = rhi.driverInfo()
            dev = info.deviceName
            dev = bytes(dev).decode(errors="replace") if not isinstance(dev, str) else dev
            self.device_info = f"{rhi.backendName()} on {dev}".strip()
        except Exception:
            self.device_info = API_LABELS[self.api_name]
        print(f"Preview renderer: {self.device_info}")

        self._vbufs = {}
        for name, data in (("sphere", meshes.sphere()), ("plane", meshes.plane())):
            raw = data.tobytes()
            buf = rhi.newBuffer(QRhiBuffer.Type.Immutable, QRhiBuffer.UsageFlag.VertexBuffer, len(raw))
            if not buf.create():
                raise RuntimeError("vertex buffer")
            self._vbufs[name] = (buf, data.shape[0], raw)
        self._ubufs = []
        for _ in range(2):
            ub = rhi.newBuffer(QRhiBuffer.Type.Dynamic, QRhiBuffer.UsageFlag.UniformBuffer, UBO_SIZE)
            if not ub.create():
                raise RuntimeError("uniform buffer")
            self._ubufs.append(ub)
        self._sampler = rhi.newSampler(QRhiSampler.Filter.Linear, QRhiSampler.Filter.Linear, QRhiSampler.Filter.Linear,
                                       QRhiSampler.AddressMode.Repeat, QRhiSampler.AddressMode.Repeat)
        if not self._sampler.create():
            raise RuntimeError("sampler")
        start = self._last_maps or {k: (np.full((2, 2, 4), 128, np.uint8) if k in ("albedo", "normal")
                                        else np.full((2, 2), 128, np.uint8)) for k in _TEX}
        self._make_textures(start, rhi, None)
        self._have_maps = self._last_maps is not None
        self._make_srbs(rhi)

        pipe = rhi.newGraphicsPipeline()
        pipe.setShaderStages([QRhiShaderStage(QRhiShaderStage.Type.Vertex, _load_shader("material.vert")),
                              QRhiShaderStage(QRhiShaderStage.Type.Fragment, _load_shader("material.frag"))])
        layout = QRhiVertexInputLayout()
        layout.setBindings([QRhiVertexInputBinding(meshes.STRIDE * 4)])
        F = QRhiVertexInputAttribute.Format
        layout.setAttributes([QRhiVertexInputAttribute(0, 0, F.Float3, 0),
                              QRhiVertexInputAttribute(0, 1, F.Float3, 3 * 4),
                              QRhiVertexInputAttribute(0, 2, F.Float2, 6 * 4),
                              QRhiVertexInputAttribute(0, 3, F.Float4, 8 * 4)])
        pipe.setVertexInputLayout(layout)
        pipe.setShaderResourceBindings(self._layout_srb)
        pipe.setRenderPassDescriptor(self.renderTarget().renderPassDescriptor())
        pipe.setSampleCount(self.sampleCount())
        pipe.setDepthTest(True)
        pipe.setDepthWrite(True)
        pipe.setCullMode(QRhiGraphicsPipeline.CullMode.Back)
        pipe.setFrontFace(QRhiGraphicsPipeline.FrontFace.CCW)
        if not pipe.create():
            raise RuntimeError("the graphics pipeline could not be created")
        self._pipeline = pipe

        u = rhi.nextResourceUpdateBatch()
        for buf, _, raw in self._vbufs.values():
            u.uploadStaticBuffer(buf, raw)
        if self._first_upload is not None:
            for name, img in self._first_upload:
                u.uploadTexture(self._textures[name], img)
                u.generateMips(self._textures[name])
            self._first_upload = None
        cb.resourceUpdate(u)

    _first_upload = None

    def _make_textures(self, maps: dict[str, np.ndarray], rhi, u) -> None:
        uploads = []
        new = {}
        for name in _TEX:
            a = maps[name]
            h, w = a.shape[:2]
            if a.ndim == 3:
                img = QImage(a.tobytes(), w, h, w * 4, QImage.Format.Format_RGBA8888).copy()
            else:
                img = QImage(a.tobytes(), w, h, w, QImage.Format.Format_Grayscale8).copy() \
                    .convertToFormat(QImage.Format.Format_RGBA8888)
            tex = rhi.newTexture(QRhiTexture.Format.RGBA8, QSize(w, h), 1,
                                 QRhiTexture.Flag.MipMapped | QRhiTexture.Flag.UsedWithGenerateMips)
            if not tex.create():
                raise RuntimeError("texture")
            new[name] = tex
            uploads.append((name, img))
        old = self._textures
        self._textures = new
        for t in old.values():
            t.destroy()            # QRhi releases it once no frame in flight uses it
        if u is None:
            self._first_upload = uploads
        else:
            for name, img in uploads:
                u.uploadTexture(self._textures[name], img)
                u.generateMips(self._textures[name])

    def _make_srbs(self, rhi) -> None:
        S = QRhiShaderResourceBinding.StageFlag
        both = S.VertexStage | S.FragmentStage
        srbs = []
        for ub in self._ubufs:
            srb = rhi.newShaderResourceBindings()
            binds = [QRhiShaderResourceBinding.uniformBuffer(0, both, ub)]
            for i, name in enumerate(_TEX):
                stage = both if name == "height" else S.FragmentStage
                binds.append(QRhiShaderResourceBinding.sampledTexture(i + 1, stage, self._textures[name], self._sampler))
            srb.setBindings(binds)
            if not srb.create():
                raise RuntimeError("shader resource bindings")
            srbs.append(srb)
        old = self._srbs
        self._srbs = srbs
        if self._layout_srb is None:
            self._layout_srb = srbs[0]       # the pipeline's layout reference: kept for the device's lifetime
        for o in old:
            if o is not self._layout_srb:
                o.destroy()

    def releaseResources(self):
        self._pipeline = None
        self._rhi = None

    def set_maps(self, maps_u8: dict[str, np.ndarray]) -> None:
        self._pending = maps_u8
        self._last_maps = maps_u8
        self.update()

    # ------------------------------------------------------------ frame
    def _uniforms(self, model: np.ndarray, view_proj: np.ndarray, cam: np.ndarray, tiling: tuple[float, float]) -> bytes:
        from .viewer import LIGHTS
        _, lights, top, bot, band, expo = LIGHTS.get(self.s.light, LIGHTS["studio"])
        parts = [view_proj, model]
        vec = [cam[0], cam[1], cam[2], 1.0,
               tiling[0], tiling[1], float(self.s.displacement) * 0.12, float(_MODE.get(self.s.mode, 0))]
        for d, _ in lights:
            n = np.array(d, np.float32)
            n /= np.linalg.norm(n)
            vec += [*n, 0.0]
        for _, c in lights:
            vec += [*c, 0.0]
        vec += [*top, 0.0, *bot, 0.0, float(band), float(expo), float(self.s.displacement) * 0.045, 0.0]
        data = b"".join(meshes.column_major(m) for m in parts) + np.array(vec, np.float32).tobytes()
        assert len(data) == UBO_SIZE, len(data)
        return data

    def render(self, cb):
        if not self._ok or getattr(self, "_pipeline", None) is None:
            return
        try:
            self._render(cb)
        except Exception as e:
            self._fail(f"{API_LABELS[self.api_name]}: {e}")

    def _render(self, cb):
        rhi = self._rhi
        u = rhi.nextResourceUpdateBatch()
        if self._pending is not None:
            maps, self._pending = self._pending, None
            self._make_textures(maps, rhi, u)
            self._make_srbs(rhi)
            self._have_maps = True
        size = self.renderTarget().pixelSize()
        w, h = max(1, size.width()), max(1, size.height())
        both = self.s.shape == "both"
        dist = camera_distance(self.s.shape, w / h, self.s.zoom)
        cam = np.array([0.0, 0.0, dist], np.float32)
        view_proj = (_qmatrix_to_np(rhi.clipSpaceCorrMatrix()) @ meshes.perspective(32.0, w / h, 0.1, 100.0)
                     @ meshes.look_at(cam, (0, 0, 0), (0, 1, 0)))
        items = []
        if self.s.shape in ("sphere", "both"):
            items.append(("sphere", -BOTH_OFFSET if both else 0.0))
        if self.s.shape in ("plane", "both"):
            items.append(("plane", BOTH_OFFSET if both else 0.0))
        t = float(self.s.tiling)
        for i, (name, x) in enumerate(items):
            model = meshes.translate(x, 0, 0) @ meshes.rotate(self.s.pitch, "x") @ meshes.rotate(self.s.yaw, "y")
            if name == "plane":
                model = model @ meshes.scale(PLANE_SCALE["both" if both else "plane"])
                tiling = (t, t)
            else:
                model = model @ meshes.scale(SPHERE_SCALE["both" if both else "sphere"])
                tiling = (t * 0.5, t * 0.5)
            u.updateDynamicBuffer(self._ubufs[i], 0, UBO_SIZE, self._uniforms(model, view_proj, cam, tiling))
        from .viewer import BACKGROUNDS
        bg = BACKGROUNDS.get(self.s.background, BACKGROUNDS["auto"])[1]
        cb.beginPass(self.renderTarget(), QColor(bg), QRhiDepthStencilClearValue(1.0, 0), u)
        if self._have_maps:
            cb.setGraphicsPipeline(self._pipeline)
            cb.setViewport(QRhiViewport(0, 0, w, h))
            for i, (name, _) in enumerate(items):
                buf, count, _ = self._vbufs[name]
                cb.setShaderResources(self._srbs[i])
                cb.setVertexInput(0, [(buf, 0)])
                cb.draw(count)
        cb.endPass()

    # ------------------------------------------------------------ interaction (same as the OpenGL view)
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
