"""Renders the lumo materials logo: the bold "lumo" wordmark with its light line, in black on a white tile
with rounded corners. Writes the app icon (.ico / .png), the sidebar mark and the installer wizard images.

    python packaging/make_icons.py [path/to/Poppins-Bold.ttf]

Needs only Pillow. The outputs are committed; run this again only to change the logo.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "lumo_materials" / "assets" / "icons"
PACK = ROOT / "packaging"

INK = (17, 17, 19, 255)          # the wordmark
TRACK = (212, 212, 216, 255)      # the faint line under it (light grey on the white tile)
TILE = (255, 255, 255, 255)
DARK = (13, 13, 14)              # the program's window colour (installer side image)
SS = 4                           # supersampling for clean edges

FONT_CANDIDATES = [
    ROOT / "lumo_materials" / "assets" / "fonts" / "Poppins-Bold.ttf",
    Path("/usr/share/fonts/truetype/google-fonts/Poppins-Bold.ttf"),
    Path("C:/Windows/Fonts/Poppins-Bold.ttf"),
]


def find_font(arg: str | None) -> Path:
    for p in ([Path(arg)] if arg else []) + FONT_CANDIDATES:
        if p.is_file():
            return p
    raise SystemExit("Poppins-Bold.ttf not found: pass its path as the first argument.")


def tile(size: int, font_path: Path, line: bool = True, radius: float = 0.235) -> Image.Image:
    """The logo at size x size px (RGBA): white rounded square, black wordmark, line below."""
    S = size * SS
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * radius), fill=TILE)
    # small icons: the word fills more of the tile and the line is left out (it would be a smudge)
    small = size <= 24
    target_w = S * (0.80 if small else 0.70)
    px = 10
    font = ImageFont.truetype(str(font_path), px)
    while True:
        f2 = ImageFont.truetype(str(font_path), px + 2)
        if f2.getlength("lumo") > target_w:
            break
        font, px = f2, px + 2
    l, t, r, b = d.textbbox((0, 0), "lumo", font=font)
    tw, th = r - l, b - t
    gap = S * 0.075
    lw = max(SS, round(S * 0.022))       # line thickness
    total = th + (gap + lw * 2 if line and not small else 0)
    x = (S - tw) / 2 - l
    y = (S - total) / 2 - t - (S * 0.01)
    d.text((x, y), "lumo", font=font, fill=INK)
    if line and not small:
        ly = (S - total) / 2 + th + gap
        x0, x1 = (S - tw) / 2, (S + tw) / 2
        d.rounded_rectangle((x0, ly, x1, ly + lw), radius=lw / 2, fill=TRACK)
        seg = tw * 0.38                   # the bright part of the line (the "light" of lumo)
        sx = x0 + tw * 0.24
        d.rounded_rectangle((sx, ly - lw * 0.5, sx + seg, ly + lw * 1.5), radius=lw, fill=INK)
    return im.resize((size, size), Image.LANCZOS)


def wizard_side(w: int, h: int, font_path: Path) -> Image.Image:
    im = Image.new("RGB", (w, h), DARK)
    t = tile(int(w * 0.56), font_path)
    im.paste(t, ((w - t.width) // 2, int(h * 0.36) - t.height // 2), t)
    return im


def wizard_small(size: int, font_path: Path) -> Image.Image:
    im = Image.new("RGB", (size, size), (255, 255, 255))
    t = tile(int(size * 0.86), font_path)
    bg = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    bg.alpha_composite(t, ((size - t.width) // 2, (size - t.height) // 2))
    im.paste(bg.convert("RGB"))
    return im


def main(argv: list[str]) -> int:
    font = find_font(argv[1] if len(argv) > 1 else None)
    ICONS.mkdir(parents=True, exist_ok=True)
    big = tile(256, font)
    big.save(ICONS / "app.png")
    tile(512, font).save(ICONS / "app-512.png")
    tile(128, font).save(ICONS / "mark.png")
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    frames = [tile(s, font) for s in sizes]
    frames[-1].save(ICONS / "app.ico", format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[:-1])
    wizard_side(164, 314, font).save(PACK / "wizard.bmp")
    wizard_side(328, 628, font).save(PACK / "wizard-2x.bmp")
    wizard_small(55, font).save(PACK / "wizard-small.bmp")
    wizard_small(110, font).save(PACK / "wizard-small-2x.bmp")
    print(f"logo written with {font}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
