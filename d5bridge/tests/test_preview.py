"""Preview data path: GPU buffers, picking, precompiled Direct3D/OpenGL shaders."""
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("PySide6")

from d5bridge.gui.view_common import draw_data, ray_hit  # noqa: E402

from fixtures import cylinder, leaf_cards  # noqa: E402


def test_draw_data_matches_mesh():
    m = leaf_cards("l", count=10)
    dd = draw_data(m)
    assert dd.vertices.shape[1] == 8 and dd.vertices.dtype == np.float32
    assert len(dd.indices) == m.num_triangles * 3
    # every triangle corner carries the right position
    tris, _ = m.triangulate()
    expect = m.positions[m.corner_verts][tris].astype(np.float32)
    got = dd.vertices[dd.indices.reshape(-1, 3), 0:3]
    assert np.allclose(np.sort(got.reshape(-1, 9), 0), np.sort(expect.reshape(-1, 9), 0))
    assert draw_data(m) is dd                 # cached on the mesh


def test_draw_data_not_deep_copied():
    m = cylinder("t")
    draw_data(m)
    assert not hasattr(m.copy(), "_draw")


def test_ray_hits_cylinder():
    dd = draw_data(cylinder("t", radius=0.5, height=2.0))
    t = ray_hit(dd, np.array([5.0, 0.0, 1.0]), np.array([-1.0, 0.0, 0.0]))
    assert t is not None and abs(t - 4.5) < 0.05
    assert ray_hit(dd, np.array([5.0, 0.0, 5.0]), np.array([-1.0, 0.0, 0.0])) is None


def test_shaders_compiled_for_direct3d():
    from PySide6.QtCore import QByteArray
    from PySide6.QtGui import QShader
    folder = Path(__file__).resolve().parents[1] / "d5bridge" / "gui" / "shaders"
    for name in ("mesh.vert", "mesh.frag", "wire.frag", "line.vert", "line.frag"):
        sh = QShader.fromSerialized(QByteArray((folder / f"{name}.qsb").read_bytes()))
        assert sh.isValid(), name
        kinds = {k.source() for k in sh.availableShaders()}
        assert QShader.Source.HlslShader in kinds, f"{name} has no HLSL (Direct3D 11) variant"
        assert QShader.Source.GlslShader in kinds
