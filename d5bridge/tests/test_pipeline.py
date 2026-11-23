import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

from d5bridge.fbx.reader import read_fbx
from d5bridge.fbx.writer import write_fbx
from d5bridge.io import load_any
from d5bridge.optimize.mesh import optimize_mesh
from d5bridge.optimize.textures import TextureJob, TextureOptions, process_job, run_jobs
from d5bridge.pipeline import ExportOptions, export
from d5bridge.scene import Scene, compose_trs, decompose_trs

from fixtures import cylinder, leaf_cards, make_maxtree_like


@pytest.fixture()
def maxtree(tmp_path: Path) -> Path:
    return make_maxtree_like(tmp_path / "src")


# --------------------------------------------------------------------------- #
def test_trs_roundtrip():
    m = compose_trs((1, 2, 3), (10, -40, 75), (2, 0.5, 3))
    t, r, s = decompose_trs(m)
    assert np.allclose(compose_trs(t, r, s), m)


def test_fbx_roundtrip_preserves_everything(maxtree):
    scene = read_fbx(str(maxtree))
    assert scene.up_axis == "Z"
    nodes = {n.name: n for n in scene.mesh_nodes()}
    assert set(nodes) == {f"Acer_0{i}_{p}" for i in (1, 2, 3) for p in ("trunk", "leaves")}
    trunk = nodes["Acer_02_trunk"]
    ref = cylinder("trunk")
    assert np.array_equal(trunk.mesh.positions, ref.positions)
    assert np.allclose(trunk.mesh.normals.expanded(), ref.normals.expanded())
    assert len(trunk.mesh.uv_sets) == 2
    # world placement survives
    assert np.allclose(trunk.world_matrix()[:3, 3], [6, 0, 0])
    leaf = nodes["Acer_01_leaves"].materials[0]
    assert set(leaf.maps) >= {"base_color", "opacity", "roughness"}
    assert leaf.maps["roughness"].invert          # glossiness file name -> inverted
    assert leaf.is_foliage and leaf.two_sided


def test_variants_detected_from_groups(maxtree):
    scene = load_any(str(maxtree))
    assert [v.name for v in scene.variants] == ["Acer_01", "Acer_02", "Acer_03"]
    assert all(len(v.mesh_nodes()) == 2 for v in scene.variants)


def test_variants_detected_by_position(tmp_path):
    """Flat file: no groups, trees side by side -> spatial clusters."""
    s = Scene()
    trunk = cylinder("t")
    for i, x in enumerate((0, 10, 20)):
        from d5bridge.scene import Material, Node
        s.root.add(Node(f"Tree_trunk_{i}", compose_trs((x, 0, 0), (0, 0, 0), (1, 1, 1)), trunk, [Material("b")]))
        s.root.add(Node(f"Tree_leaves_{i}", compose_trs((x, 0, 0), (0, 0, 0), (1, 1, 1)),
                        leaf_cards("l", seed=i), [Material("l")]))
    p = tmp_path / "flat.fbx"
    write_fbx(str(p), s, s.root.children)
    scene = load_any(str(p))
    assert len(scene.variants) == 3
    assert all(len(v.nodes) == 2 for v in scene.variants)
    assert scene.variants[0].reason == "separate position"


def test_mesh_optimisation_is_lossless():
    m = leaf_cards("l", count=20)
    before = m.copy()
    rep = optimize_mesh(m)
    assert rep.faces_removed == 1                      # the zero-area triangle
    assert m.num_faces == before.num_faces - 1
    # every remaining corner renders exactly as before
    keep = np.arange(before.num_corners - 3)
    assert np.array_equal(m.positions[m.corner_verts], before.positions[before.corner_verts][keep])
    assert np.array_equal(m.normals.expanded(), before.normals.expanded()[keep])
    assert np.array_equal(m.uv_sets[0].attr.expanded(), before.uv_sets[0].attr.expanded()[keep])
    assert len(m.normals.data) == 20                   # one normal per flat card


def test_duplicate_uv_channel_dropped():
    m = cylinder("t")
    rep = optimize_mesh(m)
    assert len(m.uv_sets) == 1
    assert any("duplicate UV" in n for n in rep.notes)


# --------------------------------------------------------------------------- #
def _pixels(p):
    return np.asarray(Image.open(p))


def test_texture_lossless_conversions(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    rng = np.random.default_rng(0)
    rgb = rng.integers(0, 255, (64, 64, 3), dtype=np.uint8)
    Image.fromarray(rgb).save(src / "a.tif")
    grey = rng.integers(0, 255, (64, 64), dtype=np.uint8)
    Image.fromarray(np.dstack([grey] * 3)).save(src / "rough_rgb.png")
    rgba = np.dstack([rgb, np.full((64, 64), 255, np.uint8)])
    Image.fromarray(rgba, "RGBA").save(src / "opaque.png")
    opts = TextureOptions()
    out = tmp_path / "out"

    r = process_job(TextureJob("base_color", str(src / "a.tif"), "A_BaseColor"), out, opts)
    assert r.output.endswith(".png") and np.array_equal(_pixels(r.output), rgb)

    r = process_job(TextureJob("roughness", str(src / "rough_rgb.png"), "R"), out, opts)
    px = _pixels(r.output)
    assert px.ndim == 2 and np.array_equal(px, grey)   # stored as 1 channel, same values

    r = process_job(TextureJob("roughness", str(src / "rough_rgb.png"), "G", invert=True), out, opts)
    assert np.array_equal(_pixels(r.output), 255 - grey)

    r = process_job(TextureJob("base_color", str(src / "opaque.png"), "O"), out, opts)
    assert _pixels(r.output).shape == (64, 64, 3)       # opaque alpha dropped
    assert np.array_equal(_pixels(r.output), rgb)

    r = process_job(TextureJob("normal", str(src / "a.tif"), "N", flip_green=True), out, opts)
    px = _pixels(r.output)
    assert np.array_equal(px[..., 1], 255 - rgb[..., 1]) and np.array_equal(px[..., 0], rgb[..., 0])


def test_16bit_with_8bit_content_is_reduced(tmp_path):
    a = np.random.default_rng(0).integers(0, 255, (32, 32), dtype=np.uint16) * 257
    Image.fromarray(a.astype(np.uint16)).save(tmp_path / "h16.png")
    r = process_job(TextureJob("roughness", str(tmp_path / "h16.png"), "x"), tmp_path / "o", TextureOptions())
    px = _pixels(r.output)
    assert px.dtype == np.uint8 and np.array_equal(px.astype(np.uint16) * 257, a)


def test_true_16bit_kept(tmp_path):
    a = np.random.default_rng(0).integers(0, 65535, (32, 32), dtype=np.uint16)
    Image.fromarray(a).save(tmp_path / "h16.png")
    r = process_job(TextureJob("displacement", str(tmp_path / "h16.png"), "x"), tmp_path / "o", TextureOptions())
    assert np.array_equal(np.asarray(Image.open(r.output)).astype(np.uint16), a)


def test_opacity_packed_into_alpha(tmp_path):
    rgb = np.random.default_rng(0).integers(0, 255, (32, 32, 3), dtype=np.uint8)
    mask = (np.random.default_rng(1).random((32, 32)) > 0.5).astype(np.uint8) * 255
    Image.fromarray(rgb).save(tmp_path / "c.jpg", quality=100)
    Image.fromarray(mask).save(tmp_path / "m.png")
    j = TextureJob("base_color", str(tmp_path / "c.jpg"), "L", alpha_from=str(tmp_path / "m.png"))
    r = process_job(j, tmp_path / "o", TextureOptions())
    px = _pixels(r.output)
    jpg = np.asarray(Image.open(tmp_path / "c.jpg"))
    assert px.shape[2] == 4 and np.array_equal(px[..., 3], mask) and np.array_equal(px[..., :3], jpg)


def test_identical_images_written_once(tmp_path):
    rgb = np.random.default_rng(0).integers(0, 255, (32, 32, 3), dtype=np.uint8)
    Image.fromarray(rgb).save(tmp_path / "one.tif")
    Image.fromarray(rgb).save(tmp_path / "two.png")
    res = run_jobs([TextureJob("base_color", str(tmp_path / "one.tif"), "A"),
                    TextureJob("base_color", str(tmp_path / "two.png"), "B")], tmp_path / "o",
                   TextureOptions())
    assert res[0].output == res[1].output
    assert len(list((tmp_path / "o").iterdir())) == 1


def test_jpeg_copied_byte_for_byte(tmp_path):
    Image.fromarray(np.random.default_rng(0).integers(0, 255, (32, 32, 3), dtype=np.uint8)).save(tmp_path / "a.jpg")
    r = process_job(TextureJob("base_color", str(tmp_path / "a.jpg"), "A"), tmp_path / "o", TextureOptions())
    assert Path(r.output).read_bytes() == (tmp_path / "a.jpg").read_bytes()


# --------------------------------------------------------------------------- #
def test_full_export(maxtree, tmp_path):
    scene = load_any(str(maxtree))
    opts = ExportOptions(out_dir=str(tmp_path / "out"))
    res = export(scene, scene.variants, None, opts)
    assert [Path(f).name for f in res.files] == ["Acer_01.fbx", "Acer_02.fbx", "Acer_03.fbx"]
    tex = sorted(p.name for p in (tmp_path / "out" / "maxtree_like" / "textures").iterdir())
    # bark .tif and its .png copy are one file; constant specular became a value
    assert len([t for t in tex if "BaseColor" in t]) == 2
    assert not any("Specular" in t for t in tex)
    # exported files re-import with textures and the variant on the ground at the origin
    for f in res.files:
        s = read_fbx(f)
        lo, hi = s.world_bounds()
        assert abs(lo[2]) < 1e-9 and abs((lo[0] + hi[0]) / 2) < 1e-9
        leaf = [m for m in s.materials() if m.name == "MT_leaf"][0]
        assert all(Path(r.path).is_file() for r in leaf.maps.values())
        assert set(leaf.maps) >= {"base_color", "opacity", "roughness"}
    # the base colour carries the leaf mask in alpha
    bc = _pixels(tmp_path / "out" / "maxtree_like" / "textures" / "MT_leaf_BaseColor.png")
    assert bc.shape[2] == 4 and set(np.unique(bc[..., 3])) <= {0, 255}


def test_export_only_selected_objects(maxtree, tmp_path):
    scene = load_any(str(maxtree))
    v = scene.variants[1]
    trunk_only = {id(n) for n in v.mesh_nodes() if n.name.endswith("trunk")}
    res = export(scene, [v], trunk_only, ExportOptions(out_dir=str(tmp_path), split_variants=False))
    s = read_fbx(res.files[0])
    assert [n.name for n in s.mesh_nodes()] == ["Acer_02_trunk"]


@pytest.mark.skipif(shutil.which("assimp") is None, reason="assimp CLI not installed")
def test_assimp_reads_export(maxtree, tmp_path):
    scene = load_any(str(maxtree))
    res = export(scene, scene.variants, None, ExportOptions(out_dir=str(tmp_path)))
    for f in res.files:
        out = subprocess.run(["assimp", "info", f], capture_output=True, text=True)
        assert out.returncode == 0, out.stdout + out.stderr
        assert "Meshes:" in out.stdout and "MT_leaf_BaseColor.png" in out.stdout


# --------------------------------------------------------------------------- #
def test_obj_reader(tmp_path):
    (tmp_path / "leaf_Albedo.png").write_bytes(b"")
    Image.new("RGB", (4, 4)).save(tmp_path / "leaf_Albedo.png")
    (tmp_path / "m.mtl").write_text("newmtl leaf\nKd 1 1 1\nmap_Kd leaf_Albedo.png\nmap_d leaf_Albedo.png\n")
    (tmp_path / "m.obj").write_text(
        "mtllib m.mtl\no plant\nv 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n"
        "vn 0 0 1\nusemtl leaf\nf 1/1/1 2/2/1 3/3/1 4/4/1\n")
    s = load_any(str(tmp_path / "m.obj"))
    n = s.mesh_nodes()[0]
    assert n.mesh.num_faces == 1 and n.mesh.face_sizes[0] == 4
    assert n.materials[0].maps["base_color"].exists()


def test_megascans_folder(tmp_path, maxtree):
    root = tmp_path / "plant_abc"
    for i in (1, 2):
        d = root / f"Var{i}"
        d.mkdir(parents=True)
        shutil.copy(maxtree, d / f"Var{i}_LOD0.fbx")
        shutil.copy(maxtree, d / f"Var{i}_LOD1.fbx")
    tex = root / "Textures" / "Atlas"
    tex.mkdir(parents=True)
    for ch in ("Albedo", "Normal", "Roughness", "Opacity"):
        Image.new("RGB", (8, 8)).save(tex / f"abc_4K_{ch}.jpg")
    (root / "abc.json").write_text(json.dumps({"id": "abc", "meta": []}))
    s = load_any(str(root))
    assert [v.name for v in s.variants] == ["Var1", "Var2"]
    assert all("LOD0" in v.reason for v in s.variants)


def test_max_bundle_loader(tmp_path, maxtree):
    """Bundle as written by the 3ds Max exporter (Corona materials pre-converted)."""
    b = tmp_path / "bundle"
    b.mkdir()
    shutil.copy(maxtree, b / "scene.fbx")
    gloss = str(maxtree.parent / "maps" / "leaf_glossiness.png")
    manifest = {
        "version": 2, "fbx": "scene.fbx", "max_file": str(tmp_path / "tree.max"),
        "materials": {"MT_leaf": {
            "name": "MT_leaf", "source_type": "CoronaPhysicalMtl", "base_color": [1, 1, 1],
            "roughness": 0.6, "two_sided": True, "is_foliage": True,
            "maps": {"base_color": {"path": "C:\\old\\pc\\maps\\leaf_diffuse.png"},
                     "roughness": {"path": gloss, "invert": True},
                     "normal": {"path": str(maxtree.parent / "maps" / "bark_normal.png"), "flip_green": True}}}},
        "nodes": [{"name": "Acer_01_leaves", "layer": "Tree A", "hidden": True}],
        "variant_hints": {"groups": {"Acer_01": ["Acer_01_trunk", "Acer_01_leaves"],
                                     "Acer_02": ["Acer_02_trunk", "Acer_02_leaves"]}},
        "scene_assets": [str(maxtree.parent / "maps" / "leaf_diffuse.png")],
    }
    (b / "manifest.json").write_text(json.dumps(manifest))
    s = load_any(str(b))
    assert [v.name for v in s.variants] == ["Acer_01", "Acer_02"]
    leaf = [m for m in s.materials() if m.name == "MT_leaf"][0]
    assert leaf.source_type == "CoronaPhysicalMtl"
    assert leaf.maps["base_color"].exists()             # re-found from another PC's path
    assert leaf.maps["roughness"].invert and leaf.normal_convention == "opengl"
    node = [n for n in s.mesh_nodes() if n.name == "Acer_01_leaves"][0]
    assert node.tags.get("hidden_in_max") == "1" and node.layer == "Tree A"
