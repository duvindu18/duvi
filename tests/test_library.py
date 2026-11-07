import json
import os
import shutil
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lumo_materials.engine import adjust, maps  # noqa: E402
from lumo_materials.engine.presets import GenParams  # noqa: E402
from lumo_materials.library import paths  # noqa: E402
from lumo_materials.library.drafts import DraftStore  # noqa: E402
from lumo_materials.library.export import ExportOptions, export_folder, export_zip  # noqa: E402
from lumo_materials.library.settings import Settings  # noqa: E402
from lumo_materials.library.store import (UNCATEGORIZED, Library, LibraryError, inspect_folder,  # noqa: E402
                                          prepare_folder)

rng = np.random.default_rng(3)


def sample_maps(n=48):
    src = np.clip(rng.random((n, n, 3)).astype(np.float32) * 0.5 + 0.25, 0, 1)
    return maps.generate(src, GenParams())


class TempLib(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lib = prepare_folder(self.tmp / "lib")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def photo_file(self, name="photo.jpg"):
        p = self.tmp / name
        Image.fromarray((rng.random((40, 40, 3)) * 255).astype(np.uint8)).save(p)
        return p


class NamesAndFolders(TempLib):
    def test_safe_name(self):
        self.assertEqual(paths.safe_name('Wall: "old" <1>?'), "Wall old 1")
        self.assertEqual(paths.safe_name("con"), "con_")
        self.assertEqual(paths.safe_name("COM1.txt"), "COM1.txt_")
        self.assertEqual(paths.safe_name("  ...  "), "Material")
        self.assertEqual(paths.safe_name("trailing. . "), "trailing")
        self.assertEqual(len(paths.safe_name("x" * 300)), paths.MAX_NAME)

    def test_inspect_states(self):
        self.assertEqual(inspect_folder(self.tmp / "nope")["state"], "new")
        (self.tmp / "empty").mkdir()
        self.assertEqual(inspect_folder(self.tmp / "empty")["state"], "empty")
        (self.tmp / "other").mkdir()
        (self.tmp / "other" / "notes.txt").write_text("hi")
        self.assertEqual(inspect_folder(self.tmp / "other")["state"], "other")
        self.assertEqual(inspect_folder(self.tmp / "lib")["state"], "library")
        self.assertEqual(inspect_folder(Path(self.tmp.anchor))["state"], "refused")     # a whole drive
        if sys.platform == "win32":
            windir = os.environ.get("WINDIR", r"C:\Windows")
            self.assertEqual(inspect_folder(Path(windir) / "lumo")["state"], "refused")
        else:
            self.assertEqual(inspect_folder("/usr/share/x")["state"], "refused")
        self.assertEqual(inspect_folder(Path.home())["state"], "refused")
        self.assertEqual(inspect_folder(self.tmp / "app" / "lib", app_dir=self.tmp / "app")["state"], "refused")
        self.assertEqual(inspect_folder(self.tmp, app_dir=self.tmp / "app")["state"], "refused")  # contains the app
        with mock.patch.dict(os.environ, {"ProgramFiles": str(self.tmp / "pf")}):
            self.assertEqual(inspect_folder(self.tmp / "pf" / "lumo")["state"], "refused")

    def test_prepare_other_folder_keeps_files(self):
        o = self.tmp / "other"
        o.mkdir()
        (o / "notes.txt").write_text("hi")
        prepare_folder(o)
        self.assertEqual((o / "notes.txt").read_text(), "hi")
        self.assertTrue((o / "Materials").is_dir() and (o / "library.json").exists() and (o / "_Trash").is_dir())

    def test_refuses_non_library_without_create(self):
        (self.tmp / "plain").mkdir()
        with self.assertRaises(LibraryError):
            Library(self.tmp / "plain")


class CreateAndEdit(TempLib):
    def test_create_layout_and_roundtrip(self):
        mp = sample_maps()
        src = self.photo_file()
        m = self.lib.create(mp, "Stucco Wall", "Walls", tags=["Plaster", "white", "plaster"], source=src,
                            generation=GenParams().to_dict())
        f = m.folder
        self.assertEqual(f, self.lib.root / "Materials" / "Walls" / "Stucco Wall")
        for name in ("material.json", "albedo.png", "normal.png", "roughness.png", "metallic.png", "height.png",
                     "ao.png", "thumb.jpg", "preview_sphere.png", "preview_plane.png", "source/original.jpg"):
            self.assertTrue((f / name).exists(), name)
        self.assertFalse((f / "originals").exists())
        with Image.open(f / "height.png") as im:
            self.assertIn(im.mode, ("I;16", "I"))
        with Image.open(f / "preview_sphere.png") as im:
            self.assertEqual(im.mode, "RGBA")
        data = json.loads((f / "material.json").read_text())
        self.assertEqual(data["tags"], ["plaster", "white"])
        self.assertEqual((data["width"], data["height"]), (48, 48))
        self.assertIsNotNone(data["seam_score"])
        back = self.lib.load_maps(m.id)
        np.testing.assert_allclose(back["albedo"], mp["albedo"], atol=1 / 255 + 1e-6)
        np.testing.assert_allclose(back["height"], mp["height"], atol=1e-4)
        self.assertEqual(m.size_label, "48px")
        self.assertFalse(any(p.name.startswith(".") for p in (self.lib.root / "Materials" / "Walls").iterdir()))

    def test_duplicate_names_get_numbers(self):
        a = self.lib.create(sample_maps(), "Brick", "Walls")
        b = self.lib.create(sample_maps(), "brick", "Walls")
        self.assertEqual(a.name, "Brick")
        self.assertEqual(b.name, "brick (2)")

    def test_update_rename_move_tags(self):
        m = self.lib.create(sample_maps(), "Oak", "Floors")
        m = self.lib.update(m.id, name="Oak Planks", tags=["wood", "Oak"], favourite=True, description="nice")
        self.assertTrue((self.lib.root / "Materials" / "Floors" / "Oak Planks" / "albedo.png").exists())
        self.assertFalse((self.lib.root / "Materials" / "Floors" / "Oak").exists())
        m = self.lib.update(m.id, name="oak planks")  # case-only rename
        self.assertEqual(m.folder.name, "oak planks")
        m = self.lib.update(m.id, category="Wood")
        self.assertEqual(m.folder, self.lib.root / "Materials" / "Wood" / "oak planks")
        data = json.loads((m.folder / "material.json").read_text())
        self.assertEqual((data["name"], data["category"], data["favourite"], data["tags"]),
                         ("oak planks", "Wood", True, ["wood", "oak"]))

    def test_query(self):
        a = self.lib.create(sample_maps(), "Red Brick", "Walls", tags=["brick", "exterior"])
        b = self.lib.create(sample_maps(), "Slate", "Stone", tags=["slate"], description="dark layered stone")
        self.lib.update(b.id, favourite=True)
        self.assertEqual([m.id for m in self.lib.query("brick")], [a.id])
        self.assertEqual([m.id for m in self.lib.query("layered")], [b.id])
        self.assertEqual([m.id for m in self.lib.query(category="Walls")], [a.id])
        self.assertEqual([m.id for m in self.lib.query(tags=["exterior"])], [a.id])
        self.assertEqual([m.id for m in self.lib.query(favourites=True)], [b.id])
        self.assertEqual([m.name for m in self.lib.query(sort="name")], ["Red Brick", "Slate"])
        self.assertEqual(len(self.lib.query(recent_days=1)), 2)
        self.assertIn(("brick", 1), self.lib.tags())

    def test_bulk(self):
        a = self.lib.create(sample_maps(), "A", "Walls", tags=["x"])
        b = self.lib.create(sample_maps(), "B", "Walls")
        self.lib.bulk([a.id, b.id], category="Stone", add_tags=["new"], remove_tags=["x"], favourite=True)
        for mid in (a.id, b.id):
            m = self.lib.get(mid)
            self.assertEqual((m.category, m.tags, m.favourite), ("Stone", ["new"], True))

    def test_duplicate(self):
        a = self.lib.create(sample_maps(), "A", "Walls")
        c = self.lib.duplicate(a.id)
        self.assertNotEqual(a.id, c.id)
        self.assertEqual(c.name, "A copy")
        self.assertTrue((c.folder / "albedo.png").exists())


class AdjustStorage(TempLib):
    def test_replace_keeps_originals_and_neutral_restores(self):
        mp = sample_maps()
        m = self.lib.create(mp, "Concrete", "Floors")
        p = adjust.neutral()
        p["albedo"]["exposure"] = 1.0
        adjusted = adjust.apply(mp, p)
        m = self.lib.replace_maps(m.id, adjusted, adjustments=p)
        self.assertTrue(m.has_originals)
        orig = self.lib.load_maps(m.id, originals=True)
        cur = self.lib.load_maps(m.id)
        np.testing.assert_allclose(orig["albedo"], mp["albedo"], atol=1 / 255 + 1e-6)
        self.assertGreater(float(cur["albedo"].mean()), float(orig["albedo"].mean()))
        # adjust again from the originals (absolute): still the same untouched set
        p2 = adjust.neutral()
        p2["albedo"]["exposure"] = -1.0
        m = self.lib.replace_maps(m.id, adjust.apply(orig, p2), adjustments=p2)
        np.testing.assert_allclose(self.lib.load_maps(m.id, originals=True)["albedo"], mp["albedo"], atol=1 / 255 + 1e-6)
        # neutral -> originals become the maps again, folder removed
        m = self.lib.replace_maps(m.id, orig, adjustments=adjust.neutral())
        self.assertFalse(m.has_originals)
        self.assertIsNone(m.adjustments)
        np.testing.assert_allclose(self.lib.load_maps(m.id)["albedo"], mp["albedo"], atol=1 / 255 + 1e-6)

    def test_copy_with_adjustments(self):
        mp = sample_maps()
        p = adjust.neutral()
        p["roughness"]["invert"] = True
        c = self.lib.create(adjust.apply(mp, p), "Copy", "Walls", originals=mp, adjustments=p)
        self.assertTrue(c.has_originals)
        self.assertTrue(c.adjustments["roughness"]["invert"])
        n = self.lib.create(mp, "Plain", "Walls", originals=mp, adjustments=adjust.neutral())
        self.assertFalse(n.has_originals)


class RescanTrashCategories(TempLib):
    def test_explorer_changes(self):
        a = self.lib.create(sample_maps(), "Brick", "Walls")
        # renamed and moved in Explorer
        (self.lib.root / "Materials" / "Stone").mkdir(exist_ok=True)
        shutil.move(str(a.folder), str(self.lib.root / "Materials" / "Stone" / "Old Brick"))
        # copied in Explorer
        shutil.copytree(self.lib.root / "Materials" / "Stone" / "Old Brick", self.lib.root / "Materials" / "Stone" / "Copy")
        # a folder of maps without material.json, and a new category folder
        loose = self.lib.root / "Materials" / "Imported" / "Loose"
        loose.mkdir(parents=True)
        shutil.copy2(self.lib.root / "Materials" / "Stone" / "Copy" / "albedo.png", loose / "albedo.png")
        (self.lib.root / "library.json").unlink()
        lib = Library(self.lib.root)
        self.assertEqual(lib.count(), 3)
        names = sorted((m.category, m.name) for m in lib.all())
        self.assertEqual(names, [("Imported", "Loose"), ("Stone", "Copy"), ("Stone", "Old Brick")])
        self.assertEqual(len({m.id for m in lib.all()}), 3)
        self.assertIn("Imported", dict(lib.categories()))
        self.assertTrue((lib.root / "library.json").exists())
        self.assertEqual(lib.get(next(m.id for m in lib.all() if m.name == "Old Brick")).id, a.id)
        loose_m = next(m for m in lib.all() if m.name == "Loose")
        self.assertEqual(lib.load_maps(loose_m.id)["normal"].shape, (48, 48, 3))  # defaults for missing maps

    def test_trash_restore_empty(self):
        a = self.lib.create(sample_maps(), "A", "Walls")
        b = self.lib.create(sample_maps(), "B", "Walls")
        self.lib.trash([a.id, b.id])
        self.assertEqual(self.lib.count(), 0)
        items = self.lib.trash_items()
        self.assertEqual(sorted(t.name for t in items), ["A", "B"])
        self.lib.create(sample_maps(), "A", "Walls")      # name taken meanwhile
        r = self.lib.restore(next(t.id for t in items if t.name == "A"))
        self.assertEqual((r.name, r.category), ("A (2)", "Walls"))
        self.assertFalse((r.folder / "trash.json").exists())
        self.assertEqual(self.lib.empty_trash(), 1)
        self.assertEqual(self.lib.trash_items(), [])
        with self.assertRaises(LibraryError):
            self.lib.restore("../../etc")

    def test_categories(self):
        self.assertIn(UNCATEGORIZED, dict(self.lib.categories()))
        self.lib.create_category("Plaster")
        with self.assertRaises(LibraryError):
            self.lib.create_category("plaster")
        m = self.lib.create(sample_maps(), "P", "Plaster")
        self.lib.rename_category("Plaster", "Render")
        self.assertEqual(self.lib.get(m.id).folder, self.lib.root / "Materials" / "Render" / "P")
        self.assertTrue((self.lib.get(m.id).folder / "albedo.png").exists())
        self.assertEqual(self.lib.delete_category("Render"), 1)
        self.assertEqual(self.lib.get(m.id).category, UNCATEGORIZED)
        self.assertNotIn("Render", dict(self.lib.categories()))
        self.assertFalse((self.lib.root / "Materials" / "Render").exists())
        with self.assertRaises(LibraryError):
            self.lib.delete_category(UNCATEGORIZED)
        self.lib.reorder_categories(["Stone", "Walls"])
        self.assertEqual([c for c, _ in self.lib.categories()][:2], ["Stone", "Walls"])


class ExportTests(TempLib):
    def test_zip_plain_and_engine(self):
        a = self.lib.create(sample_maps(), "Red Brick", "Walls")
        out = export_zip(self.lib, [a.id], self.tmp / "out" / "pack.zip", ExportOptions())
        with zipfile.ZipFile(out) as z:
            self.assertEqual(sorted(z.namelist()), sorted(f"Red Brick/{n}.png" for n in
                                                          ("albedo", "normal", "roughness", "metallic", "height", "ao")))
        out2 = export_zip(self.lib, [a.id], self.tmp / "out" / "pack.zip",
                          ExportOptions(naming="engine", normal="dx", orm=True, height_bits=8))
        self.assertEqual(out2.name, "pack (2).zip")      # never overwrites
        with zipfile.ZipFile(out2) as z:
            names = set(z.namelist())
            self.assertIn("Red Brick/Red_Brick_Normal_DX.png", names)
            self.assertIn("Red Brick/Red_Brick_ORM.png", names)
            self.assertIn("Red Brick/Red_Brick_BaseColor.png", names)
            z.extractall(self.tmp / "x")
        with Image.open(self.tmp / "x" / "Red Brick" / "Red_Brick_Height.png") as im:
            self.assertEqual(im.mode, "L")
        dx = np.asarray(Image.open(self.tmp / "x" / "Red Brick" / "Red_Brick_Normal_DX.png")).astype(int)
        gl = np.asarray(Image.open(a.folder / "normal.png")).astype(int)
        np.testing.assert_allclose(dx[..., 1], 255 - gl[..., 1], atol=1)
        self.assertFalse(any(p.suffix == ".part" for p in (self.tmp / "out").iterdir()))

    def test_folder_never_overwrites(self):
        a = self.lib.create(sample_maps(), "Slate", "Stone")
        first = export_folder(self.lib, [a.id], self.tmp / "exp", ExportOptions())
        second = export_folder(self.lib, [a.id], self.tmp / "exp", ExportOptions())
        self.assertEqual([p.name for p in first + second], ["Slate", "Slate (2)"])
        self.assertTrue((second[0] / "height.png").exists())


class DraftsAndSettings(TempLib):
    def test_drafts(self):
        store = DraftStore(self.tmp / "data" / "drafts")
        src = self.photo_file()
        d = store.new("photo", source=src, name="Wall", generation=GenParams().to_dict())
        self.assertTrue(d.source.exists())
        f1, f2 = self.photo_file("a_Color.png"), self.photo_file("a_Rough.png")
        imp = store.new("import", files=[f1, f2], assignments=[{"file": str(f1), "role": "albedo"},
                                                               {"file": str(f2), "role": "roughness"}])
        self.assertEqual([p.name for p in imp.files()], ["a_Color.png", "a_Rough.png"])
        self.assertEqual(imp.assignments[0]["file"], "a_Color.png")
        listed = store.list()
        self.assertEqual({x.id for x in listed}, {d.id, imp.id})
        got = store.get(d.id)
        self.assertEqual((got.kind, got.name), ("photo", "Wall"))
        store.discard(d.id)
        self.assertEqual([x.id for x in store.list()], [imp.id])
        with self.assertRaises(ValueError):
            store.get("..")

    def test_settings(self):
        s = Settings(self.tmp / "data")
        s.set("library_dir", "D:/lib")
        self.assertEqual(Settings(self.tmp / "data").get("library_dir"), "D:/lib")
        with mock.patch.dict(os.environ, {"LUMO_LIBRARY_DIR": "E:/pinned"}):
            self.assertEqual(s.get("library_dir"), "E:/pinned")
            self.assertTrue(s.library_pinned)
        with mock.patch.dict(os.environ, {"LUMO_MATERIALS_DATA": str(self.tmp / "d2")}):
            self.assertEqual(Settings().folder, self.tmp / "d2")


if __name__ == "__main__":
    unittest.main()
