import os
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lumo_materials.engine import adjust, imageio, importer, maps, render, seamless  # noqa: E402
from lumo_materials.engine.fftops import blur_wrap  # noqa: E402
from lumo_materials.engine.presets import GenParams, for_preset, preset_names  # noqa: E402

rng = np.random.default_rng(1)


def photo(h=96, w=128):
    """Non-tileable test photo: lighting gradient + texture."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    tex = blur_wrap(rng.random((h, w)).astype(np.float32), 1.5)
    tex = (tex - tex.min()) / (tex.max() - tex.min())
    light = 0.55 + 0.35 * (xx / w) - 0.15 * (yy / h)
    base = np.stack([tex * 0.6 + 0.2, tex * 0.5 + 0.25, tex * 0.4 + 0.3], 2)
    return np.clip(base * light[..., None], 0, 1).astype(np.float32)


def periodic_texture(n=128):
    return np.clip(blur_wrap(rng.random((n, n)).astype(np.float32), 2.0) * 4 - 1.5, 0, 1)


class SeamlessTests(unittest.TestCase):
    def test_score_of_tileable_texture_is_about_one(self):
        self.assertLess(seamless.seam_score(periodic_texture()), 1.3)

    def test_score_of_photo_is_high(self):
        self.assertGreater(seamless.seam_score(photo()), 2.0)

    def test_all_modes_make_photo_tile(self):
        p = photo()
        for mode in ("periodic", "blend", "mirror"):
            out = seamless.make_seamless(p, mode)
            self.assertEqual(out.shape, p.shape, mode)
            self.assertEqual(out.dtype, np.float32, mode)
            self.assertLess(seamless.seam_score(out), 1.5, mode)

    def test_off_keeps_image(self):
        p = photo()
        np.testing.assert_array_equal(seamless.make_seamless(p, "off"), p)

    def test_periodic_keeps_detail(self):
        p = photo()[..., 0]
        out = seamless.periodic(p)
        hp_in = p - blur_wrap(p, 4)
        hp_out = out - blur_wrap(out, 4)
        inner = (slice(8, -8), slice(8, -8))
        corr = np.corrcoef(hp_in[inner].ravel(), hp_out[inner].ravel())[0, 1]
        self.assertGreater(corr, 0.97)

    def test_unknown_mode(self):
        with self.assertRaises(ValueError):
            seamless.make_seamless(photo(), "zigzag")


class FilterTests(unittest.TestCase):
    def test_blur_wrap_is_periodic_and_keeps_mean(self):
        a = rng.random((64, 80)).astype(np.float32)
        b = blur_wrap(a, 3.0)
        self.assertAlmostEqual(float(a.mean()), float(b.mean()), places=4)
        np.testing.assert_allclose(blur_wrap(np.roll(a, 7, axis=1), 3.0), np.roll(b, 7, axis=1), atol=1e-5)

    def test_blur_wrap_colour(self):
        a = rng.random((32, 32, 3)).astype(np.float32)
        self.assertEqual(blur_wrap(a, 2).shape, (32, 32, 3))


class GenerateTests(unittest.TestCase):
    def test_every_preset_generates_valid_maps(self):
        src = photo()
        for name in preset_names():
            out = maps.generate(src, for_preset(name))
            self.assertEqual(set(out), {"albedo", "normal", "roughness", "metallic", "height", "ao"}, name)
            self.assertEqual(out["albedo"].shape, src.shape)
            self.assertEqual(out["normal"].shape, src.shape)
            for k in ("roughness", "metallic", "height", "ao"):
                self.assertEqual(out[k].shape, src.shape[:2], (name, k))
            for k, v in out.items():
                self.assertEqual(v.dtype, np.float32, (name, k))
                self.assertGreaterEqual(float(v.min()), 0.0, (name, k))
                self.assertLessEqual(float(v.max()), 1.0, (name, k))
            n = out["normal"] * 2 - 1
            np.testing.assert_allclose(np.linalg.norm(n, axis=2), 1.0, atol=1e-3)
            self.assertLess(maps.score(out), 1.5, name)

    def test_normal_is_opengl_convention(self):
        n = 64
        x = np.linspace(0, 2 * np.pi, n, endpoint=False, dtype=np.float32)
        # height rises to the right on the left half -> surface leans left -> red < 0.5 there
        h = np.tile((np.sin(x) * 0.5 + 0.5)[None, :], (n, 1))
        nm = maps.normal_from(h, 2.0)
        self.assertLess(float(nm[n // 2, 2, 0]), 0.5)
        # height rises upwards (towards row 0) -> surface leans down -> green < 0.5 (OpenGL, +Y up)
        hv = np.tile((np.sin(x)[::-1] * 0.5 + 0.5)[:, None], (1, n))
        nv = maps.normal_from(np.roll(hv, 0, axis=0), 2.0)
        row = int(np.argmax(np.gradient(hv[:, 0]) * -1))  # strongest upward rise
        self.assertLess(float(nv[row, 3, 1]), 0.5)

    def test_delight_flattens_lighting(self):
        yy, xx = np.mgrid[0:96, 0:96].astype(np.float32)
        tex = periodic_texture(96)[..., None] * 0.3 + 0.35
        lit = np.clip(tex * (0.5 + 0.8 * (0.5 + 0.5 * np.sin(xx / 96 * 2 * np.pi)))[..., None], 0, 1)
        lit = np.repeat(lit, 3, axis=2) if lit.shape[2] == 1 else lit
        out = maps.delight(lit, 1.0, 0.12)
        low_in = blur_wrap(lit[..., 0], 12).std()
        low_out = blur_wrap(out[..., 0], 12).std()
        self.assertLess(low_out, low_in * 0.5)

    def test_invert_height(self):
        src = photo()
        a = maps.height_from(src, GenParams())
        b = maps.height_from(src, GenParams(invert_height=True))
        np.testing.assert_allclose(a, 1 - b, atol=1e-5)

    def test_params_roundtrip(self):
        p = for_preset("brick", normal_strength=5.5, invert_height=True)
        q = GenParams.from_dict(p.to_dict())
        self.assertEqual(p, q)
        self.assertEqual(GenParams.from_dict({"preset": "nope"}).preset, "generic")
        self.assertTrue(GenParams.from_dict({"invert_height": "true"}).invert_height)
        self.assertEqual(GenParams.from_dict({"preset": "metal"}).metallic, 1.0)


class AdjustTests(unittest.TestCase):
    def setUp(self):
        self.m = maps.generate(photo(64, 64), GenParams())

    def test_neutral_changes_nothing(self):
        out = adjust.apply(self.m, adjust.neutral())
        for k in self.m:
            np.testing.assert_allclose(out[k], self.m[k], atol=2e-3, err_msg=k)
        self.assertTrue(adjust.is_neutral({}))
        self.assertTrue(adjust.is_neutral(None))

    def test_absolute_not_cumulative(self):
        p = adjust.neutral()
        p["albedo"]["exposure"] = 1.0
        once = adjust.apply(self.m, p)["albedo"]
        twice = adjust.apply(self.m, p)["albedo"]
        np.testing.assert_array_equal(once, twice)
        self.assertGreater(float(once.mean()), float(self.m["albedo"].mean()))

    def test_controls(self):
        p = adjust.neutral()
        p["roughness"]["invert"] = True
        p["normal"]["flip_y"] = True
        p["metallic"]["shift"] = 0.5
        p["ao"]["strength"] = 0.0
        out = adjust.apply(self.m, p)
        np.testing.assert_allclose(out["roughness"], 1 - self.m["roughness"], atol=1e-5)
        np.testing.assert_allclose(out["normal"][..., 1], 1 - self.m["normal"][..., 1], atol=2e-3)
        np.testing.assert_allclose(out["metallic"], 0.5, atol=1e-5)
        np.testing.assert_allclose(out["ao"], 1.0, atol=1e-6)

    def test_hue_and_saturation(self):
        p = adjust.neutral()
        p["albedo"]["saturation"] = -1.0
        grey = adjust.apply(self.m, p, only=["albedo"])["albedo"]
        self.assertLess(float(np.abs(grey[..., 0] - grey[..., 2]).max()), 0.02)
        p = adjust.neutral()
        p["albedo"]["hue"] = 120
        self.assertGreater(float(np.abs(adjust.apply(self.m, p)["albedo"] - self.m["albedo"]).mean()), 0.005)

    def test_output_size(self):
        big = {k: imageio.resize(v, 1024, 1024) for k, v in self.m.items()}
        p = adjust.neutral()
        p["output_size"] = "512"
        out = adjust.apply(big, p)
        self.assertEqual(out["albedo"].shape, (512, 512, 3))
        self.assertEqual(out["height"].shape, (512, 512))
        np.testing.assert_allclose(np.linalg.norm(out["normal"] * 2 - 1, axis=2), 1.0, atol=1e-3)
        p["output_size"] = "2048"   # never upscales
        self.assertEqual(adjust.apply(big, p)["albedo"].shape, (1024, 1024, 3))

    def test_normalize_and_changed(self):
        p = adjust.normalize({"albedo": {"exposure": 99}, "output_size": "17", "junk": 1})
        self.assertEqual(p["albedo"]["exposure"], 3.0)
        self.assertEqual(p["output_size"], "keep")
        q = adjust.neutral()
        q["height"]["invert"] = True
        self.assertEqual(adjust.changed_maps(adjust.neutral(), q), ["height"])


class ImporterTests(unittest.TestCase):
    def test_guess_names(self):
        cases = {
            "Bricks076_2K_Color.jpg": ("albedo", "gl"),
            "Bricks076_2K_NormalGL.png": ("normal", "gl"),
            "Bricks076_2K_NormalDX.png": ("normal", "dx"),
            "bricks_normal_dx.png": ("normal", "dx"),
            "wood_nor_gl_4k.png": ("normal", "gl"),
            "Metal032_2K_Displacement.jpg": ("height", "gl"),
            "Metal032_2K_Metalness.jpg": ("metallic", "gl"),
            "Metal032_2K_Roughness.jpg": ("roughness", "gl"),
            "tiles_AO.png": ("ao", "gl"),
            "tiles_ambientOcclusion.png": ("ao", "gl"),
            "rock_ORM.png": ("orm", "gl"),
            "rock_arm_4k.png": ("orm", "gl"),
            "fabric_Gloss.png": ("gloss", "gl"),
            "fabric_basecolor.png": ("albedo", "gl"),
            "fabric_diff_2k.jpg": ("albedo", "gl"),
            "concrete_height.tif": ("height", "gl"),
            "concrete_Specular.png": ("ignore", "gl"),
            "whatever.png": ("ignore", "gl"),
            "Column_01_Color.png": ("albedo", "gl"),
        }
        for name, want in cases.items():
            self.assertEqual(importer.guess(name), want, name)

    def test_assemble_flips_dx_and_splits_orm(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            alb = (photo(32, 32) * 255).astype(np.uint8)
            Image.fromarray(alb).save(d / "m_Color.png")
            nrm = np.zeros((32, 32, 3), np.uint8)
            nrm[..., 0], nrm[..., 1], nrm[..., 2] = 128, 60, 255
            Image.fromarray(nrm).save(d / "m_NormalDX.png")
            orm = np.zeros((16, 16, 3), np.uint8)
            orm[..., 0], orm[..., 1], orm[..., 2] = 200, 100, 50
            Image.fromarray(orm).save(d / "m_ORM.png")
            gl = (np.ones((32, 32)) * 255 * 0.25).astype(np.uint8)
            Image.fromarray(gl).save(d / "m_Gloss.png")
            files = sorted(str(p) for p in d.iterdir())
            assigned = importer.guess_all(files)
            out, generated = importer.assemble(assigned, GenParams())
            self.assertEqual(generated, ["height"])
            self.assertAlmostEqual(float(out["normal"][..., 1].mean()), 1 - 60 / 255, places=2)
            self.assertAlmostEqual(float(out["roughness"].mean()), 0.75, places=2)  # gloss wins over ORM.G
            self.assertAlmostEqual(float(out["ao"].mean()), 200 / 255, places=2)
            self.assertAlmostEqual(float(out["metallic"].mean()), 50 / 255, places=2)
            self.assertEqual(out["ao"].shape, (32, 32))  # resized to albedo

    def test_duplicates_and_empty(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            Image.fromarray(np.zeros((8, 8, 3), np.uint8)).save(d / "a_Color.png")
            Image.fromarray(rng.integers(0, 255, (64, 64, 3)).astype(np.uint8)).save(d / "b_Color.png")
            a = importer.guess_all([str(d / "a_Color.png"), str(d / "b_Color.png")])
            self.assertEqual([x.role for x in a], ["ignore", "albedo"])  # larger file kept
            with self.assertRaises(importer.ImportError_):
                importer.assemble([importer.Assignment(str(d / "a_Color.png"), "ignore")], GenParams())


class RenderAndIoTests(unittest.TestCase):
    def test_sphere_and_plane(self):
        m = maps.generate(photo(64, 64), GenParams())
        s = render.sphere(m, size=64)
        self.assertEqual(s.shape, (64, 64, 4))
        self.assertEqual(float(s[0, 0, 3]), 0.0)
        self.assertGreater(float(s[32, 32, 3]), 0.99)
        self.assertTrue(np.isfinite(s).all())
        p = render.plane(m, size=48)
        self.assertEqual(p.shape, (48, 48, 3))
        self.assertTrue(0 <= p.min() and p.max() <= 1)
        self.assertEqual(render.composite(s).shape, (64, 64, 3))

    def test_png16_roundtrip_and_formats(self):
        with tempfile.TemporaryDirectory() as d:
            g = np.linspace(0, 1, 64 * 64, dtype=np.float32).reshape(64, 64)
            imageio.save_png16(g, os.path.join(d, "h.png"))
            back = imageio.load_gray(os.path.join(d, "h.png"))
            self.assertLess(float(np.abs(back - g).max()), 1 / 60000)
            rgb = photo(20, 30)
            for ext in (".png", ".jpg", ".webp", ".bmp", ".tif", ".tga"):
                Image.fromarray(imageio.to_uint8(rgb)).save(os.path.join(d, "x" + ext))
                self.assertEqual(imageio.load_rgb(os.path.join(d, "x" + ext)).shape, (20, 30, 3), ext)
            with self.assertRaises(imageio.ImageError):
                imageio.load_rgb(os.path.join(d, "missing.png"))
            Path(d, "bad.png").write_bytes(b"not an image")
            with self.assertRaises(imageio.ImageError):
                imageio.load_rgb(os.path.join(d, "bad.png"))


if __name__ == "__main__":
    unittest.main()
