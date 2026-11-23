"""Direct3D 11 preview (Qt RHI). Same look and controls as the OpenGL viewport.

QRhiWidget renders through Direct3D 11 on Windows (OpenGL/Vulkan/Metal on
other systems) from one code path. Shaders are precompiled to .qsb files
(HLSL + GLSL + SPIR-V) by shaders/build_shaders.py.

Speed: mesh buffers are prepared in the loader thread (view_common.draw_data),
textures are decoded on a thread pool and uploaded with GPU-generated mipmaps
as they arrive, and frames are only rendered when something changes.
"""
from __future__ import annotations

import struct
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PySide6.QtCore import QByteArray, QSize, Qt, QTimer, Signal
from PySide6.QtGui import (QColor, QImage, QRhiBuffer, QRhiCommandBuffer, QRhiDepthStencilClearValue,
                           QRhiGraphicsPipeline, QRhiSampler, QRhiShaderResourceBinding,
                           QRhiShaderStage, QRhiTexture, QRhiVertexInputAttribute,
                           QRhiVertexInputBinding, QRhiVertexInputLayout, QRhiViewport, QShader)
from PySide6.QtWidgets import QRhiWidget

from ..scene import Material, Mesh, Node, Scene
from .view_common import OrbitCameraMixin, draw_data, load_preview_image

SHADERS = Path(__file__).resolve().parent / "shaders"
DRAW_UBO = 64 * 3 + 16 * 11          # matches shaders/src/common.glsl
LINE_UBO = 64 + 32
VS = QRhiShaderResourceBinding.StageFlag.VertexStage
FS = QRhiShaderResourceBinding.StageFlag.FragmentStage


def _shader(name: str) -> QShader:
    return QShader.fromSerialized(QByteArray((SHADERS / f"{name}.qsb").read_bytes()))


def _mat(m: np.ndarray) -> bytes:
    # QRhi/GLSL expect column-major matrices
    return np.ascontiguousarray(m.T, dtype=np.float32).tobytes()


class _GpuMesh:
    def __init__(self, rhi, u, mesh: Mesh) -> None:
        dd = draw_data(mesh)
        vb = dd.vertices.tobytes()
        ib = dd.indices.tobytes() or b"\0\0\0\0"
        self.vbuf = rhi.newBuffer(QRhiBuffer.Type.Immutable, QRhiBuffer.UsageFlag.VertexBuffer, max(len(vb), 32))
        self.vbuf.create()
        self.ibuf = rhi.newBuffer(QRhiBuffer.Type.Immutable, QRhiBuffer.UsageFlag.IndexBuffer, len(ib))
        self.ibuf.create()
        u.uploadStaticBuffer(self.vbuf, vb if vb else b"\0" * 32)
        u.uploadStaticBuffer(self.ibuf, ib)
        self.ranges = dd.ranges

    def destroy(self) -> None:
        self.vbuf.destroy()
        self.ibuf.destroy()


class _Draw:
    """One draw call: node x material slot, with its own uniform buffer + bindings."""

    def __init__(self) -> None:
        self.ubuf = None
        self.srb = None
        self.tex_key: tuple = ()


class RhiViewport(OrbitCameraMixin, QRhiWidget):
    picked = Signal(object, bool)
    status = Signal(str)
    backend_name = "Direct3D 11"

    def __init__(self, parent=None) -> None:
        QRhiWidget.__init__(self, parent)
        self._init_camera()
        if sys.platform == "win32":
            self.setApi(QRhiWidget.Api.Direct3D11)
        elif sys.platform == "darwin":
            self.setApi(QRhiWidget.Api.Metal)
            self.backend_name = "Metal"
        else:
            self.setApi(QRhiWidget.Api.OpenGL)
            self.backend_name = "OpenGL (RHI)"
        self.setSampleCount(4)
        self.setMinimumSize(320, 240)
        self.setFocusPolicy(Qt.StrongFocus)
        self._ready = False
        self._rhi = None
        self._gpu: dict[int, _GpuMesh] = {}
        self._draws: dict[tuple, _Draw] = {}
        self._tex: dict[str, object] = {}          # key -> QRhiTexture (or None while loading)
        self._pending: dict[str, np.ndarray | None] = {}
        self._loading: set[str] = set()
        self._pool = ThreadPoolExecutor(max_workers=6)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._poll_textures)
        self._timer.start(40)
        self._dead: list = []

    @staticmethod
    def configure_default_format() -> None:
        return None

    # ------------------------------------------------------------------ #
    def set_scene(self, scene: Scene | None) -> None:
        self._release_scene()
        self.scene = scene
        self.selected.clear()
        self._model_cache.clear()
        self.visible_nodes = scene.mesh_nodes() if scene else []
        self._compute_offsets()
        self.frame(all_nodes=True)
        self.update()

    def invalidate_mesh(self, mesh: Mesh) -> None:
        g = self._gpu.pop(id(mesh), None)
        if g is not None:
            self._dead.append(g)
        try:
            del mesh._draw     # type: ignore[attr-defined]
        except AttributeError:
            pass
        self.update()

    def _release_scene(self) -> None:
        self._dead.extend(self._gpu.values())
        self._gpu.clear()
        for d in self._draws.values():
            self._dead.append(d)
        self._draws.clear()
        for t in self._tex.values():
            if t is not None and t is not getattr(self, "_white", None):
                self._dead.append(t)
        self._tex.clear()
        self._pending.clear()
        self._loading.clear()

    def _flush_dead(self) -> None:
        for obj in self._dead:
            try:
                if isinstance(obj, _Draw):
                    if obj.ubuf is not None:
                        obj.ubuf.destroy()
                    if obj.srb is not None:
                        obj.srb.destroy()
                else:
                    obj.destroy()
            except Exception:  # noqa: BLE001
                pass
        self._dead.clear()

    # ------------------------------------------------------------------ #
    def initialize(self, cb) -> None:
        rhi = self.rhi()
        if self._rhi is not rhi:
            self._rhi = rhi
            self._ready = False
            self._gpu.clear()
            self._draws.clear()
            self._tex.clear()
        if self._ready:
            return
        try:
            self._create_static(rhi)
            self._ready = True
            self.status.emit(f"Preview: {self.backend_name}")
        except Exception as e:  # noqa: BLE001
            self.status.emit(f"{self.backend_name} preview failed: {e}")

    def _create_static(self, rhi) -> None:
        u = rhi.nextResourceUpdateBatch()
        self._white = rhi.newTexture(QRhiTexture.Format.RGBA8, QSize(1, 1))
        self._white.create()
        img = QImage(1, 1, QImage.Format_RGBA8888)
        img.fill(QColor(255, 255, 255, 255))
        u.uploadTexture(self._white, img)
        self._sampler = rhi.newSampler(QRhiSampler.Filter.Linear, QRhiSampler.Filter.Linear,
                                       QRhiSampler.Filter.Linear, QRhiSampler.AddressMode.Repeat,
                                       QRhiSampler.AddressMode.Repeat)
        self._sampler.create()
        # layout SRB used to create the pipelines
        self._layout_ubuf = rhi.newBuffer(QRhiBuffer.Type.Dynamic, QRhiBuffer.UsageFlag.UniformBuffer, DRAW_UBO)
        self._layout_ubuf.create()
        self._layout_srb = self._make_srb(rhi, self._layout_ubuf, [self._white] * 4)

        vin = QRhiVertexInputLayout()
        vin.setBindings([QRhiVertexInputBinding(32)])
        vin.setAttributes([
            QRhiVertexInputAttribute(0, 0, QRhiVertexInputAttribute.Format.Float3, 0),
            QRhiVertexInputAttribute(0, 1, QRhiVertexInputAttribute.Format.Float3, 12),
            QRhiVertexInputAttribute(0, 2, QRhiVertexInputAttribute.Format.Float2, 24),
        ])
        rp = self.renderTarget().renderPassDescriptor()
        vs, fs, wfs = _shader("mesh.vert"), _shader("mesh.frag"), _shader("wire.frag")

        def pipe(frag, line: bool):
            p = rhi.newGraphicsPipeline()
            p.setShaderStages([QRhiShaderStage(QRhiShaderStage.Type.Vertex, vs),
                               QRhiShaderStage(QRhiShaderStage.Type.Fragment, frag)])
            p.setVertexInputLayout(vin)
            p.setShaderResourceBindings(self._layout_srb)
            p.setRenderPassDescriptor(rp)
            p.setSampleCount(self.sampleCount())
            p.setDepthTest(True)
            p.setDepthWrite(not line)
            p.setCullMode(QRhiGraphicsPipeline.CullMode.None_)
            if line:
                p.setPolygonMode(QRhiGraphicsPipeline.PolygonMode.Line)
                p.setDepthBias(-1)
                p.setSlopeScaledDepthBias(-1.0)
                p.setTargetBlends([_blend()])
            p.create()
            return p

        self._pipe = pipe(fs, False)
        try:
            self._wire_pipe = pipe(wfs, True)
        except Exception:  # noqa: BLE001  (backend without line polygon mode)
            self._wire_pipe = None

        # grid
        self._grid_ubuf = rhi.newBuffer(QRhiBuffer.Type.Dynamic, QRhiBuffer.UsageFlag.UniformBuffer, LINE_UBO)
        self._grid_ubuf.create()
        self._grid_srb = rhi.newShaderResourceBindings()
        self._grid_srb.setBindings([QRhiShaderResourceBinding.uniformBuffer(0, VS | FS, self._grid_ubuf)])
        self._grid_srb.create()
        gin = QRhiVertexInputLayout()
        gin.setBindings([QRhiVertexInputBinding(12)])
        gin.setAttributes([QRhiVertexInputAttribute(0, 0, QRhiVertexInputAttribute.Format.Float3, 0)])
        gp = rhi.newGraphicsPipeline()
        gp.setTopology(QRhiGraphicsPipeline.Topology.Lines)
        gp.setShaderStages([QRhiShaderStage(QRhiShaderStage.Type.Vertex, _shader("line.vert")),
                            QRhiShaderStage(QRhiShaderStage.Type.Fragment, _shader("line.frag"))])
        gp.setVertexInputLayout(gin)
        gp.setShaderResourceBindings(self._grid_srb)
        gp.setRenderPassDescriptor(rp)
        gp.setSampleCount(self.sampleCount())
        gp.setDepthTest(True)
        gp.setDepthWrite(False)
        gp.setTargetBlends([_blend()])
        gp.create()
        self._grid_pipe = gp
        self._grid_vbuf = None
        self._grid_key = None
        self._grid_count = 0
        self._startup_batch = u

    def _make_srb(self, rhi, ubuf, textures):
        srb = rhi.newShaderResourceBindings()
        b = [QRhiShaderResourceBinding.uniformBuffer(0, VS | FS, ubuf)]
        for i, t in enumerate(textures):
            b.append(QRhiShaderResourceBinding.sampledTexture(i + 1, FS, t, self._sampler))
        srb.setBindings(b)
        srb.create()
        return srb

    # ------------------------------------------------------------------ #
    def _texture(self, path: str, extract: str = ""):
        key = path + "|" + extract
        t = self._tex.get(key, "missing")
        if t != "missing":
            return t
        if key not in self._loading:
            self._loading.add(key)
            self._tex[key] = None
            fut = self._pool.submit(load_preview_image, path, extract, False)
            fut.add_done_callback(lambda f, k=key: self._pending.__setitem__(k, f.result()))
        return None

    def _poll_textures(self) -> None:
        if self._pending:
            self.update()

    def _upload_pending(self, rhi, u) -> None:
        budget = 6               # spread big uploads over frames to keep orbiting smooth
        for key in list(self._pending.keys())[:budget]:
            arr = self._pending.pop(key)
            self._loading.discard(key)
            if arr is None:
                self._tex[key] = self._white
                continue
            h, w = arr.shape[:2]
            tex = rhi.newTexture(QRhiTexture.Format.RGBA8, QSize(w, h), 1,
                                 QRhiTexture.Flag.MipMapped | QRhiTexture.Flag.UsedWithGenerateMips)
            tex.create()
            img = QImage(arr.data, w, h, w * 4, QImage.Format_RGBA8888)
            u.uploadTexture(tex, img.copy())
            u.generateMips(tex)
            self._tex[key] = tex
        if self._pending:
            QTimer.singleShot(0, self.update)

    # ------------------------------------------------------------------ #
    def _material_textures(self, m: Material) -> tuple[list, list[bool]]:
        texs, has = [], []
        for ch in ("base_color", "opacity", "normal", "roughness"):
            ref = m.maps.get(ch)
            t = self._texture(ref.path, ref.channel if ch == "opacity" else "") if ref and ref.path else None
            texs.append(t if t is not None else self._white)
            has.append(t is not None and t is not self._white)
        return texs, has

    def _draw_ubo(self, mvp, model, m: Material, has: list[bool], eye, selected: bool) -> bytes:
        nmat = np.eye(4)
        nmat[:3, :3] = np.linalg.inv(model[:3, :3]).T
        uvx = []
        for ch in ("base_color", "opacity", "normal", "roughness"):
            r = m.maps.get(ch)
            uvx += [r.uv_scale[0], r.uv_scale[1], r.uv_offset[0], r.uv_offset[1]] if r else [1, 1, 0, 0]
        rref = m.maps.get("roughness")
        dy = 1.0 if self._rhi.isYUpInFramebuffer() else -1.0
        vals = [
            *[float(x) for x in m.base_color], 1.0,
            float(m.roughness), float(m.metallic), float(m.is_foliage), float(selected),
            *[float(x) for x in has],
            float(m.is_foliage or "opacity" in m.maps), float(bool(rref and rref.invert)),
            float(m.normal_convention == "directx"), float(self.mode == "clay"),
            *uvx,
            float(eye[0]), float(eye[1]), float(eye[2]), dy,
            *self.select_col, 1.0,
            *self.grid_col, 1.0,
        ]
        return _mat(mvp) + _mat(model) + _mat(nmat) + struct.pack(f"{len(vals)}f", *vals)

    def _grid(self, rhi, u, y: float) -> None:
        step = 10 ** np.floor(np.log10(max(self._extent / 10, 1e-6)))
        n = int(self._extent / step)
        key = (round(float(y), 6), float(step), n)
        if key == self._grid_key and self._grid_vbuf is not None:
            return
        lines = []
        for i in range(-n, n + 1):
            lines += [[i * step, y, -n * step], [i * step, y, n * step],
                      [-n * step, y, i * step], [n * step, y, i * step]]
        data = np.asarray(lines, np.float32).tobytes()
        if self._grid_vbuf is not None:
            self._dead.append(self._grid_vbuf)
        self._grid_vbuf = rhi.newBuffer(QRhiBuffer.Type.Immutable, QRhiBuffer.UsageFlag.VertexBuffer, len(data))
        self._grid_vbuf.create()
        u.uploadStaticBuffer(self._grid_vbuf, data)
        self._grid_count = len(lines)
        self._grid_key = key
        self._grid_extent = float(n * step)

    def render(self, cb) -> None:
        rhi = self.rhi()
        top, bottom = self.bg
        clear = QColor.fromRgbF(*[(a + b) / 2 for a, b in zip(top, bottom)], 1.0)
        if not self._ready:
            cb.beginPass(self.renderTarget(), clear, QRhiDepthStencilClearValue(1.0, 0))
            cb.endPass()
            return
        self._flush_dead()
        u = rhi.nextResourceUpdateBatch()
        if getattr(self, "_startup_batch", None) is not None:
            u.merge(self._startup_batch)
            self._startup_batch = None
        self._upload_pending(rhi, u)
        proj, view, eye = self._camera()
        clip = np.array(rhi.clipSpaceCorrMatrix().data(), dtype=np.float64).reshape(4, 4).T
        vp = clip @ proj @ view

        draws: list[tuple[_Draw, _GpuMesh, int, int]] = []
        live: set[tuple] = set()
        for n in self.visible_nodes:
            if n.mesh is None:
                continue
            g = self._gpu.get(id(n.mesh))
            if g is None:
                g = _GpuMesh(rhi, u, n.mesh)
                self._gpu[id(n.mesh)] = g
            model = self._model(n)
            for slot, first, count in g.ranges:
                mat = n.materials[min(slot, len(n.materials) - 1)] if n.materials else Material("default")
                key = (id(n), slot)
                live.add(key)
                d = self._draws.get(key)
                if d is None:
                    d = _Draw()
                    d.ubuf = rhi.newBuffer(QRhiBuffer.Type.Dynamic, QRhiBuffer.UsageFlag.UniformBuffer, DRAW_UBO)
                    d.ubuf.create()
                    self._draws[key] = d
                texs, has = self._material_textures(mat)
                tkey = tuple(id(t) for t in texs)
                if d.srb is None or d.tex_key != tkey:
                    if d.srb is not None:
                        self._dead.append(d.srb)
                    d.srb = self._make_srb(rhi, d.ubuf, texs)
                    d.tex_key = tkey
                u.updateDynamicBuffer(d.ubuf, 0, DRAW_UBO,
                                      self._draw_ubo(vp @ model, model, mat, has, eye, id(n) in self.selected))
                draws.append((d, g, first, count))
        for key in [k for k in self._draws if k not in live]:
            self._dead.append(self._draws.pop(key))

        if self.show_grid:
            b = self._bounds(self.visible_nodes)
            self._grid(rhi, u, b[0][1] if b is not None else 0.0)
            gvals = _mat(vp) + struct.pack("8f", *self.grid_col, 1.0, self._grid_extent, 0.0, 0.0, 0.0)
            u.updateDynamicBuffer(self._grid_ubuf, 0, LINE_UBO, gvals)

        cb.beginPass(self.renderTarget(), clear, QRhiDepthStencilClearValue(1.0, 0), u)
        out = self.renderTarget().pixelSize()
        vpt = QRhiViewport(0, 0, out.width(), out.height())
        idx_fmt = QRhiCommandBuffer.IndexFormat.IndexUInt32
        cb.setGraphicsPipeline(self._pipe)
        cb.setViewport(vpt)
        for d, g, first, count in draws:
            cb.setShaderResources(d.srb)
            cb.setVertexInput(0, [(g.vbuf, 0)], g.ibuf, 0, idx_fmt)
            cb.drawIndexed(count, 1, first)
        if self.wire and self._wire_pipe is not None:
            cb.setGraphicsPipeline(self._wire_pipe)
            cb.setViewport(vpt)
            for d, g, first, count in draws:
                cb.setShaderResources(d.srb)
                cb.setVertexInput(0, [(g.vbuf, 0)], g.ibuf, 0, idx_fmt)
                cb.drawIndexed(count, 1, first)
        if self.show_grid and self._grid_vbuf is not None:
            cb.setGraphicsPipeline(self._grid_pipe)
            cb.setViewport(vpt)
            cb.setShaderResources(self._grid_srb)
            cb.setVertexInput(0, [(self._grid_vbuf, 0)])
            cb.draw(self._grid_count)
        cb.endPass()

    def releaseResources(self) -> None:
        self._release_scene()
        self._flush_dead()
        self._ready = False


def _blend():
    b = QRhiGraphicsPipeline.TargetBlend()
    b.enable = True
    b.srcColor = QRhiGraphicsPipeline.BlendFactor.SrcAlpha
    b.dstColor = QRhiGraphicsPipeline.BlendFactor.OneMinusSrcAlpha
    b.srcAlpha = QRhiGraphicsPipeline.BlendFactor.One
    b.dstAlpha = QRhiGraphicsPipeline.BlendFactor.OneMinusSrcAlpha
    return b
