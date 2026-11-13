"""Run Veil Cam's real GLSL shaders on a software GL (Mesa) to check the GPU path.

Usage: python3 tools/gl_check.py <photo> <det_500m.onnx> <out_dir> [display_rotation]

Builds a phone-like camera frame (the photo as a landscape-held phone sees it in
natural orientation), renders the detector canvas with the PASS shader, runs
SCRFD on it, maps faces back like PassMapper, then composites the landscape
output with the COMPOSITE shader. Checks: faces found, output upright, face
region anonymized, background untouched.
"""
import math, re, sys
from pathlib import Path

import cv2
import moderngl
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT.parent
sys.path.insert(0, str(REPO))
from app.core.scrfd_arcface import SCRFD  # desktop detector = reference
import onnxruntime as ort

src = (ROOT / "app/src/main/kotlin/com/veil/cam/gl/Shaders.kt").read_text()
SH = dict(re.findall(r'const val (\w+) = """(.*?)"""', src, re.S))


def desktop(glsl):
    return glsl.replace("#version 300 es", "#version 330 core")


def affine_pass(w, h, ang, scale):
    r = math.radians(ang); cs = math.cos(r) * scale; sn = math.sin(r) * scale
    cx, cy = w / 2, h / 2
    acs, asn = abs(math.cos(r)), abs(math.sin(r))
    nw = max(1, round((h * asn + w * acs) * scale)); nh = max(1, round((h * acs + w * asn) * scale))
    m = np.array([[cs, sn, cx - cs * cx - sn * cy + nw / 2 - cx], [-sn, cs, cy + sn * cx - cs * cy + nh / 2 - cy]])
    return m, (nw, nh)


def inv(m):
    a, b, c, d, e, f = m.ravel()
    det = a * e - b * d
    ia, ib, id_, ie = e / det, -b / det, -d / det, a / det
    return np.array([[ia, ib, -(ia * c + ib * f)], [id_, ie, -(id_ * c + ie * f)]])


def mat3(m):  # row-major 2x3 -> column-major mat3 tuple
    return tuple(float(v) for v in (m[0, 0], m[1, 0], 0.0, m[0, 1], m[1, 1], 0.0, m[0, 2], m[1, 2], 1.0))


def up32(v):
    return (v + 31) // 32 * 32


def main():
    photo, model, out = sys.argv[1], sys.argv[2], Path(sys.argv[3])
    rot = int(sys.argv[4]) if len(sys.argv) > 4 else 90
    out.mkdir(parents=True, exist_ok=True)
    world = cv2.imread(photo)  # BGR, upright in the world
    world = cv2.resize(world, (1080, int(1080 * world.shape[0] / world.shape[1])))
    # Natural (portrait) camera image when the phone is held at display rotation `rot`.
    k = {90: cv2.ROTATE_90_CLOCKWISE, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}[rot]
    image = cv2.rotate(world, k)
    H, W = image.shape[:2]
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)

    ctx = moderngl.create_standalone_context(backend="egl")
    vao = ctx.vertex_array(ctx.program(vertex_shader=desktop(SH["VS"]), fragment_shader="#version 330 core\nout vec4 f; void main(){f=vec4(1);}"), [])
    color = ctx.texture((W, H), 3, np.flipud(rgb).tobytes())  # row 0 = image bottom (slot convention)
    color.filter = (moderngl.LINEAR, moderngl.LINEAR)

    def run(frag, size, uniforms, textures):
        prog = ctx.program(vertex_shader=desktop(SH["VS"]), fragment_shader=desktop(frag))
        for k_, v in uniforms.items():
            if k_ in prog:
                prog[k_].value = v
        fbo = ctx.simple_framebuffer(size, components=4)
        fbo.use()
        for unit, (name, tex) in enumerate(textures):
            tex.use(unit)
            if name in prog:
                prog[name].value = unit
        ctx.vertex_array(prog, []).render(moderngl.TRIANGLES, vertices=3)
        data = np.frombuffer(fbo.read(components=4), np.uint8).reshape(size[1], size[0], 4)
        return data  # bottom-up rows

    # --- detector pass (base, faces upright for the display rotation) ---
    _, sz = affine_pass(W, H, rot, 1.0)
    scale = 480 / max(sz)
    M, s = affine_pass(W, H, rot, scale)
    cw, ch = up32(s[0]), up32(s[1])
    canvas = run(SH["PASS"], (cw, ch), {"uCanvasToImg": mat3(inv(M)), "uImgSize": (float(W), float(H)), "uCanvasH": float(ch)}, [("uSrc", color)])
    canvas_rgb = np.flipud(canvas[..., :3])
    cv2.imwrite(str(out / "pass_canvas.png"), cv2.cvtColor(canvas_rgb, cv2.COLOR_RGB2BGR))
    sess = ort.InferenceSession(model, providers=["CPUExecutionProvider"])
    dets, kps = SCRFD(sess).detect(cv2.cvtColor(canvas_rgb, cv2.COLOR_RGB2BGR), 0.35, (cw, ch))
    assert len(dets) > 0, "no face found in the GL-rendered detector canvas"
    iv = inv(M)
    faces = []
    for d in dets:
        x1, y1, x2, y2, sc = d
        cx, cy = iv @ np.array([(x1 + x2) / 2, (y1 + y2) / 2, 1.0])
        ang = math.degrees(math.atan2(iv[1, 0], iv[0, 0]))
        sc_img = math.sqrt(abs(iv[0, 0] * iv[1, 1] - iv[0, 1] * iv[1, 0]))
        faces.append((cx, cy, (x2 - x1) * sc_img, (y2 - y1) * sc_img, ang, sc))
    print("faces (image px):", [tuple(round(v, 1) for v in f) for f in faces])

    # --- blur chain (1/4 res, gaussian) as the renderer does ---
    small = cv2.resize(rgb, (W // 4, H // 4), interpolation=cv2.INTER_AREA)
    small = cv2.GaussianBlur(small, (0, 0), 2.5)
    blur = ctx.texture((W // 4, H // 4), 3, np.flipud(small).tobytes())
    blur.build_mipmaps()
    blur.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
    lut = ctx.texture3d((2, 2, 2), 3, np.array([[r, g, b] for b in (0, 1) for g in (0, 1) for r in (0, 1)], np.float32).tobytes(), dtype="f4")
    mask = ctx.texture((1, 1), 4, bytes(4))

    # --- composite to the landscape recording ---
    outW, outH = (H, W)  # quarter turn
    th = math.radians(-rot); c, sn = math.cos(th), math.sin(th)
    kfit = max(outW / H, outH / W)
    a, b, d_, e = kfit * c, -kfit * sn, kfit * sn, kfit * c
    A = np.array([[a, b, outW / 2 - a * W / 2 - b * H / 2], [d_, e, outH / 2 - d_ * W / 2 - e * H / 2]])
    FA, FB = [0.0] * 48, [0.0] * 48
    for i, (cx, cy, w, h, ang, _) in enumerate(faces[:12]):
        cov, margin = 0.2, 1.12
        hw, hh = w / 2 * (margin + cov), h / 2 * (margin + cov)
        shift = h * (0.03 + 0.08 * cov); r = math.radians(ang)
        cx2, cy2 = cx + math.sin(r) * shift, cy - math.cos(r) * shift
        FA[i * 4:i * 4 + 4] = [cx2, cy2, hw, hh]
        sigma = 2 * min(hw, hh) * (0.2 + 0.8 * 0.7) * 0.57
        lod = min(max(math.log2(max(1, sigma / 8)), 0), 8)
        FB[i * 4:i * 4 + 4] = [math.cos(r), math.sin(r), 0.12 * min(hw, hh), lod]
    uni = {
        "uOutToImg": mat3(inv(A)), "uImgSize": (float(W), float(H)), "uBlurSize": (float(W // 4), float(H // 4)), "uOutH": float(outH),
        "uFaceCount": len(faces[:12]), "uFA": [tuple(float(v) for v in FA[i:i + 4]) for i in range(0, 48, 4)],
        "uFB": [tuple(float(v) for v in FB[i:i + 4]) for i in range(0, 48, 4)], "uStyle": 0, "uEllipse": 1, "uMaskTex": 0, "uFullBlur": 0,
        "uGains": (1.0, 1.0, 1.0), "uLutOn": 0, "uLutAmount": 1.0, "uLutSize": 2.0, "uZebra": 0, "uZebraLevel": 0.95, "uFalse": 0,
        "uPeak": 0, "uPeakColor": (0.9, 0.9, 0.5), "uPeakThresh": 0.2, "uPxPerOut": 1.0,
    }
    res = run(SH["COMPOSITE"], (outW, outH), uni, [("uColor", color), ("uBlur", blur), ("uLut", lut), ("uMask", mask)])
    final = np.flipud(res[..., :3])
    cv2.imwrite(str(out / f"composite_rot{rot}.png"), cv2.cvtColor(final, cv2.COLOR_RGB2BGR))
    # Upright: the composite (without faces) must equal the world photo.
    uni["uFaceCount"] = 0
    clean = np.flipud(run(SH["COMPOSITE"], (outW, outH), uni, [("uColor", color), ("uBlur", blur), ("uLut", lut), ("uMask", mask)])[..., :3])
    ref = cv2.cvtColor(cv2.resize(world, (outW, outH)), cv2.COLOR_BGR2RGB)
    err = np.abs(clean.astype(int) - ref.astype(int)).mean()
    print(f"upright check: mean abs diff vs world photo = {err:.2f}")
    assert err < 6, "composite is not upright"
    # The main face area must be anonymized; the rest of the frame untouched.
    cx, cy = A @ np.array([faces[0][0], faces[0][1], 1.0])
    r0 = int(min(faces[0][2], faces[0][3]) * kfit * 0.35)
    fy, fx = int(cy), int(cx)
    roi = (slice(max(0, fy - r0), fy + r0), slice(max(0, fx - r0), fx + r0))
    def highpass(img):
        g = cv2.cvtColor(np.ascontiguousarray(img), cv2.COLOR_RGB2GRAY).astype(np.float32)
        return (g - cv2.GaussianBlur(g, (0, 0), 3)).ravel()
    hc, hb = highpass(clean[roi]), highpass(final[roi])
    corr = float(np.corrcoef(hc, hb)[0, 1])
    diff = float(np.abs(clean[roi].astype(int) - final[roi].astype(int)).mean())
    print(f"face region: fine-detail correlation with the original {corr:.3f}, mean change {diff:.1f}")
    assert corr < 0.2 and diff > 5, "face region not anonymized"
    far = np.ones(final.shape[:2], bool)
    for f in faces:
        fx2, fy2 = A @ np.array([f[0], f[1], 1.0])
        rr = max(f[2], f[3]) * kfit * 1.2
        yy, xx = np.ogrid[:outH, :outW]
        far &= (xx - fx2) ** 2 + (yy - fy2) ** 2 > rr * rr
    bg = np.abs(final[far].astype(int) - clean[far].astype(int)).mean()
    print(f"background change: {bg:.3f}")
    assert bg < 0.5, "background was modified"
    # Other styles / shapes / LUT on the same frame.
    uni["uFaceCount"] = len(faces[:12])
    lods = [fb[3] for fb in uni["uFB"]]
    for style, ell in ((1, 1), (2, 1), (3, 1), (0, 0)):
        for i in range(len(faces[:12])):
            fb = list(uni["uFB"][i])
            fb[3] = max(2.0, 2 * uni["uFA"][i][2] / 10) if style == 1 else lods[i]  # block px / blur level
            uni["uFB"][i] = tuple(fb)
        uni["uStyle"], uni["uEllipse"] = style, ell
        img = np.flipud(run(SH["COMPOSITE"], (outW, outH), uni, [("uColor", color), ("uBlur", blur), ("uLut", lut), ("uMask", mask)])[..., :3])
        cv2.imwrite(str(out / f"style{style}_ell{ell}_rot{rot}.png"), cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
        c2 = float(np.corrcoef(highpass(clean[roi]), highpass(img[roi]))[0, 1]) if img[roi].std() > 0 else 0.0
        bg2 = np.abs(img[far].astype(int) - clean[far].astype(int)).mean()
        print(f"style {style} ellipse {ell}: face detail correlation {c2:.3f}, background change {bg2:.3f}")
        assert c2 < 0.3 and bg2 < 0.5
    # A warm LUT must change colours everywhere (and the face stays hidden).
    warm = np.array([[r * 0.85 + 0.15, g, b * 0.8] for b in (0, 1) for g in (0, 1) for r in (0, 1)], np.float32)
    lut2 = ctx.texture3d((2, 2, 2), 3, warm.tobytes(), dtype="f4")
    uni.update({"uStyle": 0, "uEllipse": 1, "uLutOn": 1})
    img = np.flipud(run(SH["COMPOSITE"], (outW, outH), uni, [("uColor", color), ("uBlur", blur), ("uLut", lut2), ("uMask", mask)])[..., :3])
    dr = img[..., 0].astype(int).mean() - clean[..., 0].astype(int).mean()
    db = img[..., 2].astype(int).mean() - clean[..., 2].astype(int).mean()
    print(f"LUT: red {dr:+.1f}, blue {db:+.1f}")
    assert dr > 3 and db < -3
    # Film pass on top of the anonymized picture must not bring the face back.
    uni.update({"uStyle": 0, "uEllipse": 1, "uLutOn": 0})
    for i in range(len(faces[:12])):
        fb = list(uni["uFB"][i]); fb[3] = lods[i]; uni["uFB"][i] = tuple(fb)
    anon = run(SH["COMPOSITE"], (outW, outH), uni, [("uColor", color), ("uBlur", blur), ("uLut", lut), ("uMask", mask)])
    stage = ctx.texture((outW, outH), 4, anon.tobytes())
    stage.build_mipmaps(); stage.filter = (moderngl.LINEAR_MIPMAP_LINEAR, moderngl.LINEAR)
    film = {"uSize": (float(outW), float(outH)), "uTime": 3.3, "uGrain": 0.9, "uGrainSize": 1.5, "uHalation": 0.8, "uBloom": 0.8,
            "uAberration": 1.0, "uLeak": 0.6, "uBurn": 0.0, "uVignette": 0.5, "uZebra": 0, "uZebraLevel": 0.95, "uFalse": 0,
            "uPeak": 0, "uPeakColor": (1.0, 0.2, 0.2), "uPeakThresh": 0.2}
    filmed = np.flipud(run(SH["FILM"], (outW, outH), film, [("uStage", stage)])[..., :3])
    cv2.imwrite(str(out / f"film_rot{rot}.png"), cv2.cvtColor(filmed, cv2.COLOR_RGB2BGR))
    # The 35mm preset, for a look at normal strength.
    film35 = dict(film, uGrain=0.3, uGrainSize=1.3, uHalation=0.35, uBloom=0.15, uAberration=0.1, uLeak=0.0, uVignette=0.25)
    look = np.flipud(run(SH["FILM"], (outW, outH), film35, [("uStage", stage)])[..., :3])
    cv2.imwrite(str(out / f"film35_rot{rot}.png"), cv2.cvtColor(look, cv2.COLOR_RGB2BGR))
    cf = float(np.corrcoef(highpass(clean[roi]), highpass(filmed[roi]))[0, 1])
    print(f"film pass: face detail correlation with the original {cf:.3f}")
    assert cf < 0.2, "film pass revealed the face"
    print("OK")


if __name__ == "__main__":
    main()
