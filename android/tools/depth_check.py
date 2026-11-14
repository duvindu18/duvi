"""Run Veil Cam's cinematic-depth shaders (Shaders.kt) on a software GL with the real
MediaPipe person model, and compare the old path (coarse mask + Gaussian) with the new
one (guided-filter edges + background-only lens blur).

Usage: python3 tools/depth_check.py <selfie_multiclass_256x256.tflite> <out_dir> [photo]
(without a photo it uses scikit-image's public-domain astronaut portrait)
"""
import math, re, sys
from pathlib import Path

import cv2
import moderngl
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
src = (ROOT / "app/src/main/kotlin/com/veil/cam/gl/Shaders.kt").read_text()
SH = dict(re.findall(r'const val (\w+) = """(.*?)"""', src, re.S))


def desktop(glsl):
    return glsl.replace("#version 300 es", "#version 330 core")


def segment(model, rgb):
    from ai_edge_litert.interpreter import Interpreter
    it = Interpreter(model_path=model); it.allocate_tensors()
    i, o = it.get_input_details()[0], it.get_output_details()[0]
    x = cv2.resize(rgb, (256, 256), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    it.set_tensor(i["index"], x[None]); it.invoke()
    y = it.get_tensor(o["index"])[0]
    e = np.exp(y - y.max(-1, keepdims=True)); pr = e / e.sum(-1, keepdims=True)
    return 1 - pr[..., 0], pr[..., 1]  # person, hair (256x256)


def main():
    model, out = sys.argv[1], Path(sys.argv[2]); out.mkdir(parents=True, exist_ok=True)
    if len(sys.argv) > 3 and not sys.argv[3].startswith('--'):
        rgb = cv2.cvtColor(cv2.imread(sys.argv[3]), cv2.COLOR_BGR2RGB)
    else:
        from skimage import data
        rgb = data.astronaut()
    H0, W0 = rgb.shape[:2]
    k = 1080 / min(W0, H0)
    rgb = cv2.resize(rgb, (round(W0 * k) // 4 * 4, round(H0 * k) // 4 * 4), interpolation=cv2.INTER_CUBIC)
    H, W = rgb.shape[:2]
    person, hair = segment(model, rgb)
    # Bright points in the background, to show the bokeh (a darker "night" scene with --night).
    rng = np.random.default_rng(3)
    pm = cv2.resize(person, (W, H))
    if "--night" in sys.argv:
        rgb = (rgb * (0.25 + 0.75 * pm[..., None])).astype(np.uint8)
    for _ in range(140 if '--night' in sys.argv else 70):
        x, y = rng.integers(0, W), rng.integers(0, H)
        if pm[y, x] < 0.3:
            cv2.circle(rgb, (int(x), int(y)), int(rng.integers(2, 5)), tuple(int(v) for v in rng.integers(200, 256, 3)), -1, cv2.LINE_AA)

    ctx = moderngl.create_standalone_context(require=330, backend="egl")
    vao_prog_cache = {}

    def prog(name):
        if name not in vao_prog_cache:
            vao_prog_cache[name] = ctx.program(vertex_shader=desktop(SH["VS"]), fragment_shader=desktop(SH[name]))
        return vao_prog_cache[name]

    def tex(size, comps, data=None, dtype="f1", lin=True, mips=False):
        t = ctx.texture(size, comps, data, dtype=dtype)
        t.filter = (moderngl.LINEAR_MIPMAP_LINEAR if mips else (moderngl.LINEAR if lin else moderngl.NEAREST), moderngl.LINEAR if lin else moderngl.NEAREST)
        t.repeat_x = t.repeat_y = False
        return t

    def run(name, outs, uniforms, textures):
        p = prog(name)
        for k_, v in uniforms.items():
            if k_ in p: p[k_].value = v
        fbo = ctx.framebuffer(color_attachments=outs)
        fbo.use()
        ctx.viewport = (0, 0, outs[0].width, outs[0].height)
        for unit, (n, t) in enumerate(textures):
            t.use(unit)
            if n in p: p[n].value = unit
        ctx.vertex_array(p, []).render(moderngl.TRIANGLES, vertices=3)

    cv2.imwrite(str(out / "input.jpg"), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
    color = tex((W, H), 3, np.flipud(rgb).tobytes())
    # Coarse mask on the "canvas" (here: the image scaled to 480 on the long side), rows top-down.
    cw, ch = (480, round(480 * H / W)) if W >= H else (round(480 * W / H), 480)
    pc = cv2.resize(person, (cw, ch)); hc = cv2.resize(hair, (cw, ch))
    mask = tex((cw, ch), 2, np.dstack([pc, hc]).clip(0, 1).__mul__(255).astype(np.uint8).tobytes())
    img_to_people = (1 / W, 0.0, 0.0, 0.0, 1 / H, 0.0, 0.0, 0.0, 1.0)  # column-major mat3

    # ---- guided filter
    gs = 640 / max(W, H)
    GW, GH = round(W * gs), round(H * gs)
    prep = [tex((GW, GH), 4, dtype="f4", lin=False) for _ in range(4)]
    run("DEPTH_PREP", prep, {"uImgToPeople": img_to_people, "uImgSize": (float(W), float(H)), "uSize": (float(GW), float(GH))},
        [("uColor", color), ("uPeople", mask)])
    R = 7
    hb = [tex((GW, GH), 4, dtype="f4", lin=False) for _ in range(4)]
    vb = [tex((GW, GH), 4, dtype="f4", lin=False) for _ in range(4)]
    run("DEPTH_BOX4", hb, {"uDir": (1, 0), "uR": R}, [("uT0", prep[0]), ("uT1", prep[1]), ("uT2", prep[2]), ("uT3", prep[3])])
    run("DEPTH_BOX4", vb, {"uDir": (0, 1), "uR": R}, [("uT0", hb[0]), ("uT1", hb[1]), ("uT2", hb[2]), ("uT3", hb[3])])
    coef = tex((GW, GH), 4, dtype="f4", lin=False)
    run("DEPTH_COEF", [coef], {"uEps": 0.0008}, [("uT0", vb[0]), ("uT1", vb[1]), ("uT2", vb[2]), ("uT3", vb[3])])
    ch1 = tex((GW, GH), 4, dtype="f4", lin=False)
    coefA = tex((GW, GH), 4, dtype="f2")
    run("DEPTH_BOX1", [ch1], {"uDir": (1, 0), "uR": R}, [("uT0", coef)])
    run("DEPTH_BOX1", [coefA], {"uDir": (0, 1), "uR": R}, [("uT0", ch1)])

    # ---- lens blur
    QW, QH = W // 4, H // 4
    bprep = tex((QW, QH), 4, dtype="f2", mips=True)
    blur_small = cv2.GaussianBlur(cv2.resize(rgb, (QW, QH), interpolation=cv2.INTER_AREA), (0, 0), 2.5)
    ublur = tex((QW, QH), 3, np.flipud(blur_small).tobytes(), mips=True); ublur.build_mipmaps()
    lut = ctx.texture3d((2, 2, 2), 3, np.array([[r, g, b] for b in (0, 1) for g in (0, 1) for r in (0, 1)], np.float32).tobytes(), dtype="f4")
    lut.filter = (moderngl.LINEAR, moderngl.LINEAR)
    m1 = ctx.texture((1, 1), 4, bytes(4))
    shapes = ["circle", "blades", "anamorphic", "swirl"]
    results = {}
    for bloom, shape in [(0.6, 0), (0.6, 1), (0.6, 2), (0.6, 3)]:
        run("BOKEH_PREP", [bprep], {"uSize": (float(QW), float(QH)), "uBloom": bloom}, [("uColor", color), ("uCoef", coefA), ("uLocal", ublur)])
        bprep.build_mipmaps()
        bok = tex((QW, QH), 4, dtype="f2")
        radius = 0.07 * 0.5 * min(QW, QH)  # f/2.8 (MAX_BLUR * 1.4 / N)
        run("BOKEH", [bok], {"uSize": (float(QW), float(QH)), "uRadius": radius, "uTaps": 96, "uShape": shape,
                             "uAxisX": (1.0, 0.0), "uAxisY": (0.0, 1.0)}, [("uPrep", bprep)])
        for refined in (1, 0):
            if refined == 0 and shape != 0:
                continue
            o = ctx.texture((W, H), 4)
            uni = {"uOutToImg": (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0), "uImgSize": (float(W), float(H)), "uBlurSize": (float(QW), float(QH)),
                   "uOutH": float(H), "uFaceCount": 0, "uStyle": 0, "uEllipse": 1, "uMaskTex": 0, "uFullBlur": 0, "uGains": (1.0, 1.0, 1.0),
                   "uLutOn": 0, "uLutAmount": 1.0, "uLutSize": 2.0, "uImgToPeople": img_to_people, "uDepth": 3.3, "uRefined": refined, "uDepthMix": 1.0, "uFineRadius": 0.0}
            run("COMPOSITE", [o], uni, [("uColor", color), ("uBlur", ublur), ("uLut", lut), ("uMask", m1), ("uPeople", mask), ("uCoef", coefA), ("uBokeh", bok)])
            img = np.flipud(np.frombuffer(o.read(), np.uint8).reshape(H, W, 4)[..., :3])
            results[("new" if refined else "old") + "_" + shapes[shape]] = img
            cv2.imwrite(str(out / f"{'new' if refined else 'old'}_{shapes[shape]}.jpg"), cv2.cvtColor(img, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 92])
    # Smooth onset: from Off through f/22 ... f/1.4 the background must move away from the
    # sharp picture gradually, starting at (almost) zero, with no jump.
    def at(depth):
        rq = 0.07 * depth * min(QW, QH)
        run("BOKEH_PREP", [bprep], {"uSize": (float(QW), float(QH)), "uBloom": 0.5}, [("uColor", color), ("uCoef", coefA), ("uLocal", ublur)])
        bprep.build_mipmaps()
        bok = tex((QW, QH), 4, dtype="f2")
        run("BOKEH", [bok], {"uSize": (float(QW), float(QH)), "uRadius": rq, "uTaps": 96, "uShape": 0, "uAxisX": (1.0, 0.0), "uAxisY": (0.0, 1.0)}, [("uPrep", bprep)])
        o = ctx.texture((W, H), 4)
        uni = {"uOutToImg": (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0), "uImgSize": (float(W), float(H)), "uBlurSize": (float(QW), float(QH)),
               "uOutH": float(H), "uFaceCount": 0, "uGains": (1.0, 1.0, 1.0), "uLutSize": 2.0, "uImgToPeople": img_to_people,
               "uDepth": max(0.05, math.log2(max(1.0, rq)) + 0.3) if depth > 0 else 0.0, "uRefined": 1,
               "uDepthMix": min(1.0, max(0.0, (rq - 1.5) / 2.0)), "uFineRadius": rq * 4.0}
        run("COMPOSITE", [o], uni, [("uColor", color), ("uBlur", ublur), ("uLut", lut), ("uMask", m1), ("uPeople", mask), ("uCoef", coefA), ("uBokeh", bok)])
        return np.flipud(np.frombuffer(o.read(), np.uint8).reshape(H, W, 4)[..., :3]).astype(np.float32)
    sharp = rgb.astype(np.float32)
    bgm = cv2.resize(person, (W, H)) < 0.2
    stops = [0] + [22, 20, 18, 16, 14, 13, 11, 10, 9, 8, 7.1, 6.3, 5.6, 5, 4.5, 4, 3.5, 3.2, 2.8, 2.5, 2.2, 2, 1.8, 1.6, 1.4]
    prev, steps = 0.0, []
    for n in stops:
        diff = float(np.abs(at(0 if n == 0 else 1.4 / n) - sharp)[bgm].mean())
        steps.append(diff - prev); prev = diff
        print(f"  {'Off' if n == 0 else 'f/' + str(n):>7}: background change {diff:5.2f}")
    print(f"largest step between neighbouring stops {max(steps[1:]):.2f}, first step (Off -> f/22) {steps[1]:.2f}")
    # Refined alpha, for inspection.
    A = np.flipud(np.frombuffer(coefA.read(), np.float16).reshape(GH, GW, 4).astype(np.float32))
    A = cv2.resize(A, (W, H), interpolation=cv2.INTER_LINEAR)
    q = np.clip((A[..., :3] * (rgb / 255.0 - 0.5)).sum(-1) + A[..., 3], 0, 1)
    cv2.imwrite(str(out / "alpha_new.png"), (q * 255).astype(np.uint8))
    cv2.imwrite(str(out / "alpha_old.png"), (np.clip((cv2.resize(pc, (W, H)) - 0.35) / 0.4, 0, 1) * 255).astype(np.uint8))
    # Edge accuracy: how well the alpha's edges line up with the picture's edges.
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    ge = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
    for name, a in (("old", cv2.resize(pc, (W, H)).astype(np.float32)), ("new", q.astype(np.float32))):
        ae = np.hypot(cv2.Sobel(a, cv2.CV_32F, 1, 0), cv2.Sobel(a, cv2.CV_32F, 0, 1))
        sel = ae > np.percentile(ae, 98)
        print(f"{name}: image edge strength where the alpha changes = {ge[sel].mean():.1f}, alpha edge width = {((a > 0.1) & (a < 0.9)).sum() / max(1, sel.sum()):.2f}")
    # Halo: in the background next to the person, the blur should not take the person's colour.
    print("OK", W, H)


main()
