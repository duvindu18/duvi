"""The editor's background jobs, end to end against a real library folder (no Qt needed)."""
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lumo_materials import jobs  # noqa: E402
from lumo_materials.engine import adjust as adj  # noqa: E402
from lumo_materials.engine import importer as imp  # noqa: E402
from lumo_materials.engine.presets import for_preset  # noqa: E402
from lumo_materials.library.store import prepare_folder  # noqa: E402

rng = np.random.default_rng(5)


class JobTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = prepare_folder(self.tmp / "lib")
        self.photo = self.tmp / "Red_Brick_Wall_2K.jpg"
        Image.fromarray((rng.random((120, 160, 3)) * 255).astype(np.uint8)).save(self.photo)
        self.calls = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def progress(self, f, s=""):
        self.calls.append(f)

    def test_photo_preview_and_save(self):
        small, full = jobs.job_load_source(str(self.photo), 64)
        self.assertEqual(full, (160, 120))
        self.assertEqual(max(small.shape[:2]), 64)
        maps, u8, score, ms = jobs.job_photo_preview(small, for_preset("brick"))
        self.assertEqual(u8["albedo"].shape[2], 4)
        self.assertLess(score, 1.5)
        mid = jobs.job_save_photo(self.lib, str(self.photo), for_preset("brick"), 256, "Red Brick", "Walls", ["brick"],
                                  progress=self.progress)
        m = self.lib.get(mid)
        self.assertEqual((m.width, m.height), (256, 192))          # longest edge = output size
        self.assertEqual(m.generation["preset"], "brick")
        self.assertTrue(m.source_path.exists())
        self.assertEqual(self.calls[-1], 1.0)
        self.assertEqual(self.calls, sorted(self.calls))            # progress only moves forward
        # regenerate replaces the maps of the same material
        mid2 = jobs.job_save_photo(self.lib, str(m.source_path), for_preset("stone"), 128, "x", "y", [], replace_id=mid)
        self.assertEqual(mid2, mid)
        self.assertEqual(self.lib.get(mid).width, 128)
        self.assertEqual(self.lib.get(mid).generation["preset"], "stone")
        self.assertEqual(self.lib.count(), 1)

    def test_import_and_adjust(self):
        d = self.tmp / "set"
        d.mkdir()
        Image.fromarray((rng.random((64, 64, 3)) * 255).astype(np.uint8)).save(d / "Rock_Color.png")
        Image.fromarray((rng.random((64, 64)) * 255).astype(np.uint8)).save(d / "Rock_Roughness.png")
        assigned = imp.guess_all([str(p) for p in sorted(d.iterdir())])
        base, generated, full = jobs.job_assemble_preview(assigned, for_preset("stone"), True, 32)
        self.assertEqual(full, (64, 64))
        self.assertEqual(sorted(generated), ["ao", "height", "metallic", "normal"])
        self.assertEqual(base["albedo"].shape, (32, 32, 3))

        p = adj.neutral()
        p["roughness"]["invert"] = True
        first = jobs.job_adjust_preview(base, p, None, None)[0]
        q = adj.clone(p)
        q["albedo"]["exposure"] = 1.0
        second = jobs.job_adjust_preview(base, q, first, p)[0]
        np.testing.assert_array_equal(second["roughness"], first["roughness"])   # unchanged map reused
        self.assertGreater(float(second["albedo"].mean()), float(first["albedo"].mean()))

        mid = jobs.job_save_import(self.lib, assigned, for_preset("stone"), True, p, "Rock", "Stone", ["rock"])
        m = self.lib.get(mid)
        self.assertEqual(m.origin, "import")
        self.assertTrue(m.has_originals)
        orig = self.lib.load_maps(mid, originals=True)
        cur = self.lib.load_maps(mid)
        np.testing.assert_allclose(cur["roughness"], 1 - orig["roughness"], atol=2 / 255)

        # adjust as a copy keeps the original untouched; replace with neutral restores it
        base2, _ = jobs.job_load_base(self.lib, mid, 32)
        np.testing.assert_allclose(base2["roughness"], imp_resize(orig["roughness"], 32), atol=0.02)
        p2 = adj.neutral()
        p2["height"]["invert"] = True
        copy_id = jobs.job_save_adjust(self.lib, mid, p2, "copy", "Rock adjusted", "Stone", ["rock"])
        self.assertNotEqual(copy_id, mid)
        self.assertEqual(self.lib.get(copy_id).name, "Rock adjusted")
        self.assertFalse(self.lib.get(mid).adjustments["height"]["invert"])
        jobs.job_save_adjust(self.lib, mid, adj.neutral(), "replace", "", "", [])
        self.assertFalse(self.lib.get(mid).has_originals)
        np.testing.assert_allclose(self.lib.load_maps(mid)["roughness"], orig["roughness"], atol=1 / 255 + 1e-6)


def imp_resize(a, edge):
    from lumo_materials.engine.imageio import fit_within
    return fit_within(a, edge)


if __name__ == "__main__":
    unittest.main()
