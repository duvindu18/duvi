"""MaxTree-style libraries: separate Maps folder, foreign texture paths, no 3ds Max."""
import shutil
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from d5bridge.fbx.writer import write_fbx  # noqa: E402
from d5bridge.io import load_any  # noqa: E402
from d5bridge.library import build_index, find_library_root  # noqa: E402
from d5bridge.scene import Material, Node, Scene, TextureRef, compose_trs  # noqa: E402

from fixtures import cylinder, leaf_cards  # noqa: E402


def _library(tmp: Path, layout: str = "v16") -> Path:
    root = tmp / "MT_PM_V16"
    maps = root / ("MT_PM_V16_Maps" if layout == "v16" else "Maps") / "Acer"
    fbx = root / ("MT_PM_V16_Forest_Pack_Mesh_Corona" if layout == "v16" else "FBX")
    for d in (maps, fbx, root / "MT_PM_V16_Previews", root / "Scene Vray"):
        d.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(0)
    Image.fromarray(rng.integers(0, 255, (16, 16, 3), dtype=np.uint8)).save(maps / "MT_PM_V16_Acer_bark_diffuse.jpg")
    Image.fromarray(rng.integers(0, 255, (16, 16, 3), dtype=np.uint8)).save(maps / "MT_PM_V16_Acer_leaf_diffuse.png")
    Image.fromarray(rng.integers(0, 255, (16, 16), dtype=np.uint8)).save(maps / "MT_PM_V16_Acer_leaf_opacity.png")
    Image.fromarray(rng.integers(0, 255, (16, 16), dtype=np.uint8)).save(maps / "MT_PM_V16_Acer_leaf_glossiness.png")
    # a preview image with the same name must never win
    Image.new("RGB", (4, 4)).save(root / "MT_PM_V16_Previews" / "MT_PM_V16_Acer_leaf_diffuse.png")

    s = Scene(up_axis="Z")
    # texture paths as stored on the author's PC, and one saved as .tif that now ships as .jpg
    bark = Material("MT_PM_V16_Acer_bark", maps={
        "base_color": TextureRef(r"D:\MaxTree\work\maps\MT_PM_V16_Acer_bark_diffuse.tif")})
    leaf = Material("MT_PM_V16_Acer_leaf", maps={
        "base_color": TextureRef(r"D:\MaxTree\work\maps\MT_PM_V16_Acer_leaf_diffuse.png")})
    lonely = Material("MT_PM_V16_Acer_leaf_backside")          # no maps at all
    g = s.root.add(Node("MT_PM_V16_Acer_01", compose_trs((0, 0, 0), (0, 0, 0), (1, 1, 1))))
    g.add(Node("trunk", np.eye(4), cylinder("trunk"), [bark]))
    g.add(Node("leaves", np.eye(4), leaf_cards("leaves"), [leaf]))
    g.add(Node("leaves_back", np.eye(4), leaf_cards("lb", seed=3), [lonely]))
    write_fbx(str(fbx / "MT_PM_V16_Acer_01.fbx"), s, s.root.children)
    (root / "Scene Vray" / "MT_PM_V16_Acer_01.max").write_bytes(b"\xd0\xcf\x11\xe0 not really a max file")
    return root


@pytest.mark.parametrize("layout", ["v16", "classic"])
def test_missing_textures_found_in_maps_folder(tmp_path, layout):
    root = _library(tmp_path, layout)
    fbx = next(root.rglob("*.fbx"))
    assert find_library_root(fbx) == root
    s = load_any(str(fbx))
    mats = {m.name: m for m in s.materials()}
    bark, leaf = mats["MT_PM_V16_Acer_bark"], mats["MT_PM_V16_Acer_leaf"]
    assert bark.maps["base_color"].path.endswith("MT_PM_V16_Acer_bark_diffuse.jpg")   # .tif -> .jpg
    assert "Previews" not in leaf.maps["base_color"].path
    # siblings of the same set were picked up automatically
    assert leaf.maps["opacity"].exists() and leaf.maps["roughness"].invert
    assert leaf.is_foliage
    # a material with no maps gets its set by name
    assert mats["MT_PM_V16_Acer_leaf_backside"].maps.get("base_color") is not None
    assert all(r.exists() for m in s.materials() for r in m.maps.values())


def test_max_without_3dsmax_uses_library_fbx(tmp_path, monkeypatch):
    root = _library(tmp_path)
    monkeypatch.setattr("d5bridge.max.bridge.find_max_installs", lambda: [])
    s = load_any(str(root / "Scene Vray" / "MT_PM_V16_Acer_01.max"))
    assert len(s.mesh_nodes()) == 3
    assert "without 3ds Max" in s.warnings[0]
    assert all(r.exists() for m in s.materials() for r in m.maps.values())


def test_library_folder_lists_every_model(tmp_path):
    root = _library(tmp_path)
    src = next(root.rglob("*.fbx"))
    shutil.copy(src, src.with_name("MT_PM_V16_Acer_02.fbx"))
    s = load_any(str(root))
    assert [v.name for v in s.variants] == ["MT_PM_V16_Acer_01", "MT_PM_V16_Acer_02"]


def test_index_is_cached(tmp_path):
    root = _library(tmp_path)
    assert build_index(root) is build_index(root)
