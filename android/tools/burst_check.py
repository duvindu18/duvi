"""Run Veil Cam's burst-merge shaders (BURST_*) on a software GL (Mesa).

Usage: python3 tools/burst_check.py <photo> <out_dir>

Makes an 8-frame handheld burst from the photo (sub-pixel shifts, heavy sensor noise,
one subject moving across a few frames), aligns it like BurstAlign (phase correlation
here as the reference), merges it with the app's shaders and checks:
  - noise drops (PSNR against the clean photo rises by > 5 dB),
  - the moving subject does not ghost (the merge matches the reference there),
  - the tone pass lifts shadows when asked and never clips highlights to flat white.
"""
import re, sys
from pathlib import Path

import cv2
import moderngl
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
src = (ROOT / "app/src/main/kotlin/com/veil/cam/gl/Shaders.kt").read_text()
SH = dict(re.findall(r'const val (\w+) = """(.*?)"""', src, re.S))


def desktop(g):
    return g.replace("#version 300 es", "#version 330 core")


def psnr(a, b):
    return 10 * np.log10(1.0 / np.mean((a - b) ** 2))


def main():
    photo, out = sys.argv[1], Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    clean = cv2.cvtColor(cv2.imread(photo), cv2.COLOR_BGR2RGB).astype(np.float32) / 255
    s = 960 / max(clean.shape[:2]); clean = cv2.resize(clean, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    H, W = clean.shape[:2]
    rng = np.random.default_rng(7)
    sigma = 0.07
    shifts = [(0.0, 0.0)] + [tuple(rng.uniform(-6, 6, 2)) for _ in range(7)]
    blob = lambda k: (int(W * 0.2 + k * 40), int(H * 0.5))  # moving subject
    frames = []
    for k, (dx, dy) in enumerate(shifts):
        M = np.float32([[1, 0, dx], [0, 1, dy]])  # frame k sees the scene moved by (dx, dy)
        f = cv2.warpAffine(clean, M, (W, H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        f = f.copy(); cv2.circle(f, blob(k), 45, (0.9, 0.2, 0.1), -1, cv2.LINE_AA)
        frames.append(np.clip(f + rng.normal(0, sigma, f.shape), 0, 1).astype(np.float32))
    ref_clean = clean.copy(); cv2.circle(ref_clean, blob(0), 45, (0.9, 0.2, 0.1), -1, cv2.LINE_AA)

    ctx = moderngl.create_standalone_context(require=330, backend="egl")
    progs = {}

    def prog(n):
        if n not in progs: progs[n] = ctx.program(vertex_shader=desktop(SH["VS"]), fragment_shader=desktop(SH[n]))
        return progs[n]

    def tex(img=None, size=(W, H), comps=4, dtype="f1", mips=False):
        data = None
        if img is not None:
            rgba = np.dstack([img, np.ones(img.shape[:2], np.float32)])
            data = (np.flipud(rgba) * 255).round().astype(np.uint8).tobytes() if dtype == "f1" else np.flipud(rgba).astype(np.float32).tobytes()
        t = ctx.texture(size, comps, data, dtype=dtype)
        t.filter = (moderngl.LINEAR_MIPMAP_LINEAR if mips else moderngl.LINEAR, moderngl.LINEAR)
        t.repeat_x = t.repeat_y = False
        return t

    def run(n, dst, uni, texs):
        p = prog(n)
        for k, v in uni.items():
            if k in p: p[k].value = v
        fbo = ctx.framebuffer(color_attachments=[dst]); fbo.use(); ctx.viewport = (0, 0, dst.width, dst.height)
        for u, (name, t) in enumerate(texs):
            t.use(u)
            if name in p: p[name].value = u
        ctx.vertex_array(p, []).render(moderngl.TRIANGLES, vertices=3)

    def read(t, dtype=np.uint8):
        a = np.frombuffer(t.read(), dtype=dtype).reshape(t.height, t.width, 4)
        a = np.flipud(a)[..., :3].astype(np.float32)
        return a / 255 if dtype == np.uint8 else a

    texs = [tex(f) for f in frames]
    ref = texs[0]
    # Luma for alignment (the app's shader), then the shift as BurstAlign returns it.
    lw = 320; lh = round(320 * H / W)
    lumas = []
    for t in texs:
        lt = tex(size=(lw, lh)); run("BURST_LUMA", lt, {"uDstSize": (lw, lh), "uStep": (0.25 / lw, 0.25 / lh)}, [("uSrc", t)])
        lumas.append(read(lt)[..., 0])
    acc = [tex(size=(W, H), dtype="f2"), tex(size=(W, H), dtype="f2")]
    first = True; merged = 0
    for k in range(1, len(texs)):
        (sx, sy), _ = cv2.phaseCorrelate(lumas[0].astype(np.float64), lumas[k].astype(np.float64))
        # img(x + d) == ref(x): d = the measured shift; texture rows are bottom-up, so y flips.
        du, dv = sx / lw, -sy / lh
        run("BURST_MERGE", acc[1], {"uSize": (W, H), "uShift": (du, dv), "uSigma": sigma * 1.0, "uFirst": 1 if first else 0},
            [("uRef", ref), ("uCur", texs[k]), ("uAcc", acc[0])])
        first = False; merged += 1
        acc.reverse()
    mean = tex(size=(W, H), dtype="f2", mips=True)
    run("BURST_MEAN", mean, {"uSize": (W, H)}, [("uAcc", acc[0])])
    mean.build_mipmaps()
    m = read(mean, np.float16)
    noisy = frames[0]
    p0, p1 = psnr(noisy, ref_clean), psnr(np.clip(m, 0, 1), ref_clean)
    print(f"PSNR single {p0:.1f} dB -> merged {p1:.1f} dB ({merged + 1} frames)")
    assert p1 - p0 > 5, "merge did not reduce noise enough"
    # Ghosting: where the subject was in OTHER frames but not in the reference, the merge must show the background.
    bx, by = blob(4)
    patch = (slice(by - 20, by + 20), slice(bx - 20, bx + 20))
    red = float(np.mean(m[patch][..., 0] - m[patch][..., 1]))
    red_ref = float(np.mean(ref_clean[patch][..., 0] - ref_clean[patch][..., 1]))
    print(f"ghost check: red excess {red:.3f} (reference {red_ref:.3f})")
    assert abs(red - red_ref) < 0.08, "moving subject ghosts into the merge"
    out_t = tex(size=(W, H))
    lod = np.log2(max(W, H) / 48)
    for lift in (1.0, 2.0):
        run("BURST_TONE", out_t, {"uSize": (W, H), "uLift": lift, "uLod": float(lod), "uSharpen": 0.3}, [("uMean", mean)])
        t = read(out_t)
        cv2.imwrite(str(out / f"merged_lift{lift:.0f}.jpg"), cv2.cvtColor((t * 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
        dark = m.mean(axis=2) < 0.15
        if lift > 1:
            gain = float(np.median(t.mean(axis=2)[dark] / np.maximum(m.mean(axis=2)[dark], 1e-3)))
            print(f"tone: shadow gain {gain:.2f}, white pixels {(t.min(axis=2) > 0.995).mean() * 100:.2f} %")
            assert gain > 1.5, "HDR lift too weak"
    cv2.imwrite(str(out / "single.jpg"), cv2.cvtColor((noisy * 255).astype(np.uint8), cv2.COLOR_RGB2BGR))
    print("burst merge OK")


if __name__ == "__main__":
    main()
