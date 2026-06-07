#!/usr/bin/env python3
"""Generate all RxVision app/PWA icons from the official logo.

Place the source logo at  frontend/public/brand/source.png  (square, the Rx mark),
then run:  python3 frontend/scripts/gen-icons.py

Outputs:
  public/brand/rxvision-mark.png   transparent, trimmed mark (used inside the app UI)
  public/icons/icon-192.png        PWA "any" (white bg)
  public/icons/icon-512.png        PWA "any" (white bg)
  public/icons/icon-maskable-512.png  PWA maskable (white bg + safe padding)
  public/icons/apple-touch-icon.png   iOS home-screen (180, white, no alpha)
  public/favicon.ico               browser tab
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "public" / "brand" / "RxVision-Logo.png"
ICONS = ROOT / "public" / "icons"
BRAND = ROOT / "public" / "brand"
WHITE = (255, 255, 255, 255)


def load_mark_transparent() -> Image.Image:
    """Load the source, drop the (near-)white background, trim to the mark."""
    img = Image.open(SRC).convert("RGBA")
    px = img.getdata()
    out = [(r, g, b, 0) if (r > 244 and g > 244 and b > 244) else (r, g, b, a)
           for (r, g, b, a) in px]
    img.putdata(out)
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def on_canvas(mark: Image.Image, size: int, pad_ratio: float, bg=None) -> Image.Image:
    """Center the (transparent) mark on a square canvas with padding."""
    canvas = Image.new("RGBA", (size, size), bg if bg else (0, 0, 0, 0))
    inner = int(size * (1 - 2 * pad_ratio))
    m = mark.copy()
    m.thumbnail((inner, inner), Image.LANCZOS)
    canvas.alpha_composite(m, ((size - m.width) // 2, (size - m.height) // 2))
    return canvas


def main() -> None:
    assert SRC.exists(), f"Missing source logo at {SRC}"
    ICONS.mkdir(parents=True, exist_ok=True)
    BRAND.mkdir(parents=True, exist_ok=True)
    mark = load_mark_transparent()

    # In-app transparent mark
    on_canvas(mark, 512, 0.04).save(BRAND / "rxvision-mark.png")

    # PWA "any" — mark on white, light rounding-free (launcher handles shape)
    on_canvas(mark, 192, 0.12, WHITE).save(ICONS / "icon-192.png")
    on_canvas(mark, 512, 0.12, WHITE).save(ICONS / "icon-512.png")

    # Maskable — extra safe padding so nothing clips inside Android's mask
    on_canvas(mark, 512, 0.22, WHITE).save(ICONS / "icon-maskable-512.png")

    # Apple touch — white, flattened (no alpha; iOS rounds corners itself)
    apple = on_canvas(mark, 180, 0.12, WHITE).convert("RGB")
    apple.save(ICONS / "apple-touch-icon.png")

    # Favicon
    fav = on_canvas(mark, 64, 0.08, WHITE)
    fav.save(ROOT / "public" / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])

    print("✓ icons generated from", SRC.name)


if __name__ == "__main__":
    main()
