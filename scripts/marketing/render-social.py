#!/usr/bin/env python3
"""Render RxVision social cards from the shared brand kit.

    python3 scripts/marketing/render-social.py --all      # every card
    python3 scripts/marketing/render-social.py li01-manifesto

LinkedIn cards are 1200×1500, Facebook/Instagram cards 1080×1350.
Copy lives in docs/marketing/linkedin-campaign.md and docs/marketing/posts-webinar-week.md.
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
FONTS = Path(__file__).resolve().parent / "fonts"
LOGO = ROOT / "frontend" / "public" / "icons" / "icon-512.png"

LINKEDIN = (1200, 1500)
INSTAGRAM = (1080, 1350)

BG = (15, 23, 42)  # slate-900 #0f172a
WHITE = (255, 255, 255)
ACCENT = (129, 140, 248)  # indigo-400 #818cf8
MUTED = (148, 163, 184)  # slate-400
FAINT = (100, 116, 139)  # slate-500
GLOW_A = (79, 70, 229)  # brand-600 #4f46e5
GLOW_B = (124, 58, 237)  # violet-600 #7c3aed


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def background(w: int, h: int) -> Image.Image:
    """Dark canvas with two soft brand glows (top-right, bottom-left)."""
    img = Image.new("RGB", (w, h), BG)
    glow = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(glow)
    d.ellipse([w - 380, -340, w + 420, 440], fill=GLOW_A)
    d.ellipse([-480, h - 400, 340, h + 420], fill=GLOW_B)
    glow = glow.filter(ImageFilter.GaussianBlur(260))
    return Image.blend(img, glow, 0.40)


def draw_tokens(d: ImageDraw.ImageDraw, x: int, y: int, line: str,
                f: ImageFont.FreeTypeFont, highlight: set[str]) -> None:
    """Draw one headline line, colouring highlighted words with the accent."""
    space = d.textlength(" ", font=f)
    for word in line.split(" "):
        key = word.strip(".,;:!·»«").lower()
        d.text((x, y), word, font=f, fill=ACCENT if key in highlight else WHITE)
        x += d.textlength(word, font=f) + space


def eyebrow(d: ImageDraw.ImageDraw, x: int, y: int, text: str) -> None:
    f = font("Inter-SemiBold.ttf", 26)
    d.line([x, y + 14, x + 56, y + 14], fill=ACCENT, width=3)
    cx = x + 80
    for ch in text:  # manual tracking — PIL has no letter-spacing
        d.text((cx, y), ch, font=f, fill=ACCENT)
        cx += d.textlength(ch, font=f) + 6


def footer(img: Image.Image, d: ImageDraw.ImageDraw, w: int, h: int, margin: int) -> None:
    y = h - 190
    if LOGO.exists():
        mark = Image.open(LOGO).convert("RGBA").resize((84, 84), Image.LANCZOS)
        img.paste(mark, (margin, y), mark)
    d.text((margin + 108, y + 20), "RxVision", font=font("InterDisplay-Bold.ttf", 42), fill=WHITE)
    f = font("Inter-Regular.ttf", 32)
    d.text((w - margin - d.textlength("rxvision.gr", font=f), y + 30),
           "rxvision.gr", font=f, fill=FAINT)


def render(slug: str, spec: dict) -> Path:
    w, h = spec.get("canvas", LINKEDIN)
    margin = spec.get("margin", 100)
    img = background(w, h)
    d = ImageDraw.Draw(img)

    size = spec.get("size", 92)
    f = font("InterDisplay-Bold.ttf", size)
    leading = int(size * 1.22)
    highlight = {word.lower() for word in spec.get("highlight", [])}

    eyebrow(d, margin, spec.get("eyebrow_y", 430), spec.get("eyebrow", "RXVISION"))

    y = spec.get("top", 520)
    for line in spec["headline"]:
        draw_tokens(d, margin, y, line, f, highlight)
        y += leading

    if spec.get("sub"):
        fs = font("Inter-Regular.ttf", spec.get("sub_size", 42))
        d.text((margin, y + 46), spec["sub"], font=fs, fill=MUTED)

    footer(img, d, w, h, margin)
    out = ROOT / spec.get("out", "docs/marketing/linkedin-assets") / f"{slug}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, "PNG", optimize=True)
    return out


# --- Cards -------------------------------------------------------------------
POSTS: dict[str, dict] = {
    # LinkedIn — καμπάνια εκκίνησης (docs/marketing/linkedin-campaign.md)
    "li01-manifesto": {
        "headline": ["Κάθε φαρμακείο", "κάθεται πάνω σε", "δεδομένα που δεν", "έχει δει ποτέ."],
        "highlight": ["δεδομένα"],
        "sub": "Εμείς τα βγάζουμε στην επιφάνεια.",
        "size": 88,
        "top": 500,
    },
    # Facebook / Instagram — εβδομάδα webinar (docs/marketing/posts-webinar-week.md)
    "w03-screenshots-telos": {
        "headline": ["Τα screenshots", "τελείωσαν.", "Παρασκευή, live."],
        "highlight": ["live"],
        "sub": "11/09 — ζωντανή παρουσίαση, χωρίς μοντάζ.",
        "canvas": INSTAGRAM,
        "size": 84,
        "eyebrow_y": 400,
        "top": 470,
        "sub_size": 38,
        "out": "docs/marketing/social-assets",
    },
}


def main() -> int:
    args = sys.argv[1:]
    slugs = list(POSTS) if not args or args[0] == "--all" else args
    for slug in slugs:
        if slug not in POSTS:
            print(f"unknown card: {slug} (available: {', '.join(POSTS)})")
            return 1
        print(render(slug, POSTS[slug]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
