"""Synthetic test assets: a MaxTree-like file with three tree variants."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

from d5bridge.fbx.writer import write_fbx
from d5bridge.scene import (IndexedAttr, Material, Mesh, Node, Scene, TextureRef, UVSet,
                            compose_trs)


def cylinder(name: str, radius=0.2, height=3.0, seg=12, rings=6) -> Mesh:
    verts, faces, uvs, uv_idx = [], [], [], []
    for r in range(rings + 1):
        for s in range(seg + 1):
            a = 2 * np.pi * s / seg
            verts.append([radius * np.cos(a), radius * np.sin(a), height * r / rings])
            uvs.append([s / seg, r / rings])
    w = seg + 1
    cv = []
    for r in range(rings):
        for s in range(seg):
            q = [r * w + s, r * w + s + 1, (r + 1) * w + s + 1, (r + 1) * w + s]
            cv += q
            faces.append(4)
    pos = np.array(verts, float)
    # duplicate seam vertices are welded by the optimiser only if bit-identical
    m = Mesh(name, pos, np.array(faces, np.int32), np.array(cv, np.int32))
    m.uv_sets = [UVSet("UVChannel_1", IndexedAttr(np.array(uvs, float), np.array(cv, np.int32))),
                 UVSet("UVChannel_2", IndexedAttr(np.array(uvs, float), np.array(cv, np.int32)))]
    n = pos[np.array(cv)].copy()
    n[:, 2] = 0
    n /= np.linalg.norm(n, axis=1, keepdims=True)
    m.normals = IndexedAttr(n, np.arange(len(cv), dtype=np.int32))   # expanded on purpose
    m.face_material = np.zeros(len(faces), np.int32)
    return m


def leaf_cards(name: str, count=40, seed=0) -> Mesh:
    rng = np.random.default_rng(seed)
    pos, cv, uvs = [], [], []
    for i in range(count):
        c = rng.uniform([-1.2, -1.2, 2.0], [1.2, 1.2, 4.0])
        u = rng.normal(size=3)
        u /= np.linalg.norm(u)
        v = np.cross(u, [0, 0, 1])
        v /= np.linalg.norm(v) + 1e-9
        quad = [c - 0.2 * u - 0.2 * v, c + 0.2 * u - 0.2 * v, c + 0.2 * u + 0.2 * v, c - 0.2 * u + 0.2 * v]
        base = len(pos)
        pos += quad
        cv += [base, base + 1, base + 2, base + 3]
        uvs += [[0, 0], [1, 0], [1, 1], [0, 1]]
    # one degenerate face (zero area) like real exports sometimes contain
    pos += [pos[0], pos[0], pos[0]]
    b = len(pos) - 3
    cv += [b, b + 1, b + 2]
    sizes = [4] * count + [3]
    m = Mesh(name, np.array(pos, float), np.array(sizes, np.int32), np.array(cv, np.int32))
    m.uv_sets = [UVSet("UVChannel_1", IndexedAttr(np.array(uvs + [[0, 0]] * 3, float),
                                                  np.arange(len(cv), dtype=np.int32)))]
    m.compute_flat_normals()
    m.normals = IndexedAttr(m.normals.expanded(), np.arange(len(cv), dtype=np.int32))
    m.face_material = np.zeros(len(sizes), np.int32)
    return m


def make_textures(folder: Path) -> dict[str, str]:
    folder.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1)
    S = 256
    out = {}
    bark = rng.integers(0, 255, (S, S, 3), dtype=np.uint8)
    # 16-bit TIFF that only holds 8-bit data (common from Photoshop exports)
    Image.fromarray(bark).save(folder / "bark_diffuse.tif")
    out["bark_diffuse"] = str(folder / "bark_diffuse.tif")
    Image.fromarray(bark).save(folder / "bark_diffuse_copy.png")       # same image, another name
    out["bark_copy"] = str(folder / "bark_diffuse_copy.png")
    nrm = rng.integers(100, 160, (S, S, 3), dtype=np.uint8)
    nrm[..., 2] = 255
    Image.fromarray(nrm).save(folder / "bark_normal.png")
    out["bark_normal"] = str(folder / "bark_normal.png")
    leaf = np.dstack([rng.integers(0, 120, (S, S), dtype=np.uint8),
                      rng.integers(80, 255, (S, S), dtype=np.uint8),
                      rng.integers(0, 60, (S, S), dtype=np.uint8),
                      np.full((S, S), 255, np.uint8)])                  # opaque alpha
    Image.fromarray(leaf, "RGBA").save(folder / "leaf_diffuse.png")
    out["leaf_diffuse"] = str(folder / "leaf_diffuse.png")
    yy, xx = np.mgrid[0:S, 0:S]
    mask = (((xx - S / 2) ** 2 + (yy - S / 2) ** 2) < (S * 0.4) ** 2).astype(np.uint8) * 255
    Image.fromarray(np.dstack([mask] * 3)).save(folder / "leaf_opacity.png")   # grey stored as RGB
    out["leaf_opacity"] = str(folder / "leaf_opacity.png")
    gloss = rng.integers(30, 90, (S, S), dtype=np.uint8)
    Image.fromarray(gloss).save(folder / "leaf_glossiness.png")
    out["leaf_gloss"] = str(folder / "leaf_glossiness.png")
    Image.fromarray(np.full((S, S, 3), 40, np.uint8)).save(folder / "leaf_specular.png")  # constant
    out["leaf_spec"] = str(folder / "leaf_specular.png")
    return out


def make_maxtree_like(folder: Path) -> Path:
    tex = make_textures(folder / "maps")
    scene = Scene(up_axis="Z", unit_scale_cm=1.0)
    bark = Material("MT_bark", maps={"base_color": TextureRef(tex["bark_diffuse"]),
                                     "normal": TextureRef(tex["bark_normal"])})
    bark2 = Material("MT_bark_alt", maps={"base_color": TextureRef(tex["bark_copy"])})
    leaf = Material("MT_leaf", maps={"base_color": TextureRef(tex["leaf_diffuse"]),
                                     "opacity": TextureRef(tex["leaf_opacity"]),
                                     "roughness": TextureRef(tex["leaf_gloss"], invert=True),
                                     "specular": TextureRef(tex["leaf_spec"])})
    trunk = cylinder("trunk")
    for i, x in enumerate((0.0, 6.0, 12.0)):
        name = f"Acer_0{i + 1}"
        g = scene.root.add(Node(name, compose_trs((x, 0, 0), (0, 0, 15 * i), (1, 1, 1))))
        g.add(Node(f"{name}_trunk", np.eye(4), trunk, [bark if i != 2 else bark2]))
        g.add(Node(f"{name}_leaves", np.eye(4), leaf_cards(f"{name}_leaves", seed=i), [leaf]))
    path = folder / "maxtree_like.fbx"
    write_fbx(str(path), scene, scene.root.children)
    return path
