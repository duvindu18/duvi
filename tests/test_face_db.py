import numpy as np

from app.core.face_db import FaceDatabase
from app.utils.imageio import imwrite


def face_image(color):
    img = np.zeros((200, 200, 3), np.uint8)
    img[50:150, 50:150] = 255
    img[95:105, 95:105] = color
    return img


def test_sync_and_match(tmp_path, fake_engine):
    db = FaceDatabase(tmp_path / "faces")
    imwrite(tmp_path / "faces" / "Rédouane" / "a.png", face_image((0, 0, 255)))
    imwrite(tmp_path / "faces" / "Bob" / "b.png", face_image((255, 0, 0)))
    imwrite(tmp_path / "faces" / "Bob" / "empty.png", np.zeros((50, 50, 3), np.uint8))
    assert db.sync(fake_engine) == 2
    q = fake_engine.embed(face_image((0, 0, 255)), fake_engine.detect(face_image((0, 0, 255))))
    (name, sim), = db.match(q, 0.9)
    assert name == "Rédouane" and sim > 0.99
    # Cached second sync must not call embed again.
    calls = []
    orig = fake_engine.embed
    fake_engine.embed = lambda *a: calls.append(1) or orig(*a)
    db.sync(fake_engine)
    assert calls == []
    persons = {p.name: p for p in db.persons()}
    assert persons["Bob"].image_count == 2 and persons["Bob"].indexed_count == 1


def test_unknown_below_threshold(tmp_path, fake_engine):
    db = FaceDatabase(tmp_path / "faces")
    imwrite(tmp_path / "faces" / "A" / "a.png", face_image((0, 0, 255)))
    db.sync(fake_engine)
    q = np.array([[0, 1, 0]], np.float32)
    assert db.match(q, 0.5)[0][0] is None
