"""Play Store graphics from the app's own launcher icon paths (ic_launcher_fg.xml).

    python3 tools/store_graphics.py store/

Writes icon-512.png (Play icon: 512x512, full square, Play rounds it) and
feature-1024x500.png. Text uses DejaVu Sans (free licence) when present.
"""
import math, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

BG = (20, 20, 22); LIME = (228, 241, 122)
PETAL_S = [(0, 0), (-6.7, -7.3), (-5.4, -17.7), (0, -20.8), (5.4, -17.7), (6.7, -7.3), (0, 0)]
PETAL_L = [(0, 0), (-8.6, -9.4), (-6.9, -22.7), (0, -26.6), (6.9, -22.7), (8.6, -9.4), (0, 0)]


def bezier(p):
    """Two cubic segments (M p0 C p1 p2 p3 C p4 p5 p6) -> polygon."""
    out = []
    for seg in (p[0:4], p[3:7]):
        for i in range(41):
            t = i / 40
            x = sum(c * pt[0] for c, pt in zip(((1-t)**3, 3*t*(1-t)**2, 3*t*t*(1-t), t**3), seg))
            y = sum(c * pt[1] for c, pt in zip(((1-t)**3, 3*t*(1-t)**2, 3*t*t*(1-t), t**3), seg))
            out.append((x, y))
    return out


def mark(draw, cx, cy, scale):
    """The lotus: group at (54, 70) of a 108 viewport; [scale] px per viewport unit."""
    for rot, petal in ((-38, PETAL_S), (38, PETAL_S), (0, PETAL_L)):
        r = math.radians(rot); c, s = math.cos(r), math.sin(r)
        pts = [(cx + scale * (x * c - y * s), cy + scale * (x * s + y * c)) for x, y in bezier(petal)]
        draw.polygon(pts, fill=LIME)


def font(size):
    for f in ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf"):
        if Path(f).exists():
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def main(out):
    out = Path(out); out.mkdir(parents=True, exist_ok=True)
    ss = 4  # supersample
    n = 512 * ss
    im = Image.new("RGB", (n, n), BG); d = ImageDraw.Draw(im)
    k = n / 108 * 1.25  # the adaptive icon's safe zone is the inner 72/108; Play shows the full square
    mark(d, n / 2, n / 2 + (70 - 54) * k - 13 * k * 0.0 - 3 * k, k)
    im.resize((512, 512), Image.LANCZOS).save(out / "icon-512.png")

    W, H = 1024 * ss, 500 * ss
    fg = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(fg)
    k = H / 108 * 1.6
    mark(d, W * 0.24, H / 2 + 11 * k, k)
    d.text((W * 0.42, H * 0.30), "Veil Cam", font=font(int(H * 0.17)), fill=(245, 245, 247))
    d.text((W * 0.42, H * 0.55), "Pro camera. Faces stay private.", font=font(int(H * 0.065)), fill=LIME)
    fg.resize((1024, 500), Image.LANCZOS).save(out / "feature-1024x500.png")
    print("wrote", out / "icon-512.png", out / "feature-1024x500.png")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "store")
