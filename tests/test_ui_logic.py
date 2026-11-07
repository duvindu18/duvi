import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lumo_materials.ui import meshes  # noqa: E402  (no Qt import in this module)
from lumo_materials.viewmodel import LibraryFilter, grid_layout, page_window  # noqa: E402


class PagerTests(unittest.TestCase):
    def test_small(self):
        self.assertEqual(page_window(0, 1), [0])
        self.assertEqual(page_window(2, 5), [0, 1, 2, 3, 4])

    def test_large(self):
        self.assertEqual(page_window(0, 10), [0, 1, 2, 3, None, 9])
        self.assertEqual(page_window(5, 10), [0, None, 4, 5, 6, None, 9])
        self.assertEqual(page_window(9, 10), [0, None, 6, 7, 8, 9])
        for pages in range(1, 30):
            for page in range(pages):
                w = page_window(page, pages)
                nums = [x for x in w if x is not None]
                self.assertIn(page, nums)
                self.assertEqual(nums, sorted(set(nums)))
                self.assertEqual(nums[0], 0)
                self.assertEqual(nums[-1], pages - 1)
                self.assertLessEqual(len(w), 7)


class GridTests(unittest.TestCase):
    def test_fills_width(self):
        for avail in (400, 900, 996, 1500, 2600):
            cols, w = grid_layout(avail, 210, 12)
            self.assertGreaterEqual(w, 210 if cols > 1 else 120)
            self.assertLessEqual(cols * w + (cols - 1) * 12, avail)
            self.assertGreater(cols * w + (cols - 1) * 12, avail - cols - 12)
        self.assertEqual(grid_layout(996, 210, 12)[0], 4)    # the approved homepage: 4 columns


class FilterTests(unittest.TestCase):
    def test_paging_and_args(self):
        f = LibraryFilter(page_size=12, page=9)
        items = list(range(30))
        self.assertEqual(f.slice(items), list(range(24, 30)))   # clamped to the last page
        self.assertEqual(f.page, 2)
        f.view = "favourites"
        self.assertTrue(f.query_args()["favourites"])
        f.view = "recent"
        self.assertEqual(f.query_args()["recent_days"], 30)
        self.assertEqual(f.title(), "Recently added")
        f.category = "Walls"
        self.assertEqual(f.title(), "Walls")


class MeshTests(unittest.TestCase):
    def test_sphere(self):
        s = meshes.sphere(16, 32)
        self.assertEqual(s.shape, (16 * 32 * 6, meshes.STRIDE))
        self.assertEqual(s.dtype, np.float32)
        pos, nrm, uv, tan = s[:, 0:3], s[:, 3:6], s[:, 6:8], s[:, 8:12]
        np.testing.assert_allclose(np.linalg.norm(pos, axis=1), 1, atol=1e-5)
        np.testing.assert_allclose(pos, nrm, atol=1e-6)
        self.assertLess(float(np.abs((tan[:, :3] * nrm).sum(1)).max()), 1e-5)   # tangent is perpendicular
        # front point (0, 0, 1): tangent +x, bitangent (N x T) = +y = up in the image
        i = int(np.argmin(np.linalg.norm(pos - np.array([0, 0, 1]), axis=1)))
        t = tan[i, :3]
        b = np.cross(nrm[i], t) * tan[i, 3]
        self.assertGreater(t[0], 0.99)
        self.assertGreater(b[1], 0.99)
        self.assertAlmostEqual(float(uv[:, 0].max()), 2.0, places=5)
        self.assertAlmostEqual(float(uv[:, 1].max()), 1.0, places=5)

    def test_triangles_face_outwards(self):
        s = meshes.sphere(8, 16).reshape(-1, 3, meshes.STRIDE)
        p = s[:, :, 0:3]
        n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        centre = p.mean(axis=1)
        good = (n * centre).sum(1)
        area = np.linalg.norm(n, axis=1)
        self.assertTrue(np.all(good[area > 1e-6] > 0))     # counter-clockwise from outside (back faces culled)

    def test_plane(self):
        pl = meshes.plane(8).reshape(-1, 3, meshes.STRIDE)
        p = pl[:, :, 0:3]
        n = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
        self.assertTrue(np.all(n[:, 2] > 0))                # faces the camera (+z)
        flat = pl.reshape(-1, meshes.STRIDE)
        top = flat[flat[:, 1] > 1.5]
        self.assertTrue(np.allclose(top[:, 7], 0.0))        # top edge is v = 0 (first image row)

    def test_maps_to_u8(self):
        m = {"albedo": np.random.rand(64, 32, 3).astype(np.float32), "height": np.random.rand(64, 32).astype(np.float32)}
        u = meshes.maps_to_u8(m, max_edge=32)
        self.assertEqual(u["albedo"].shape, (32, 16, 4))
        self.assertEqual(u["height"].shape, (32, 16))
        self.assertTrue((u["albedo"][..., 3] == 255).all())


if __name__ == "__main__":
    unittest.main()
