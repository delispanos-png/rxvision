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
    "li02-idyka": {
        "headline": ["Δεν θα", "πληκτρολογήσεις", "ούτε μία", "συνταγή."],
        "highlight": ["ούτε", "μία"],
        "sub": "Το ΗΔΥΚΑ κατεβαίνει μόνο του. Κάθε μέρα.",
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


# --- Carousel / document decks ----------------------------------------------
def wrap(d: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        cur = ""
        for word in para.split(" "):
            trial = f"{cur} {word}".strip()
            if d.textlength(trial, font=f) <= width:
                cur = trial
            else:
                lines.append(cur)
                cur = word
        lines.append(cur)
    return lines


def render_page(page: dict, index: int, total: int, w: int, h: int, margin: int) -> Image.Image:
    img = background(w, h)
    d = ImageDraw.Draw(img)
    eyebrow(d, margin, 180, f"{index:02d} / {total:02d}")

    title_size = page.get("title_size", 68)
    ft = font("InterDisplay-Bold.ttf", title_size)
    y = page.get("top", 300)
    for line in wrap(d, page["title"], ft, w - 2 * margin):
        draw_tokens(d, margin, y, line, ft, {x.lower() for x in page.get("highlight", [])})
        y += int(title_size * 1.20)

    if page.get("body"):
        fb = font("Inter-Regular.ttf", page.get("body_size", 40))
        y += 50
        for line in wrap(d, page["body"], fb, w - 2 * margin):
            d.text((margin, y), line, font=fb, fill=MUTED)
            y += int(page.get("body_size", 40) * 1.45)

    footer(img, d, w, h, margin)
    return img


def render_deck(slug: str, deck: dict) -> Path:
    w, h = deck.get("canvas", LINKEDIN)
    margin = deck.get("margin", 100)
    pages = deck["pages"]
    imgs = [render_page(p, i, len(pages), w, h, margin) for i, p in enumerate(pages, 1)]
    out = ROOT / deck.get("out", "docs/marketing/linkedin-assets") / f"{slug}.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    imgs[0].save(out, "PDF", save_all=True, append_images=imgs[1:], resolution=150.0)
    return out


DECKS: dict[str, dict] = {
    # LinkedIn POST 4 — document post (docs/marketing/linkedin-campaign.md)
    "li04-perikopes": {
        "pages": [
            {
                "title": "Οι περικοπές δεν είναι ατυχία.\nΕίναι πρόβλεψη.",
                "highlight": ["πρόβλεψη"],
                "body": "5 έλεγχοι που γίνονται πριν πατήσεις υποβολή.",
                "title_size": 72,
                "top": 420,
            },
            {
                "title": "Γιατί κόβονται",
                "body": "Σχεδόν πάντα για τους ίδιους λίγους λόγους.\n\nΤο πρόβλημα δεν είναι ότι δεν τους ξέρεις. Είναι ότι δεν "
                        "φαίνονται όταν μπροστά σου υπάρχουν εκατοντάδες συνταγές και μία προθεσμία.",
                "top": 380,
            },
            {
                "title": "01 · Προθεσμία εκτέλεσης",
                "highlight": ["01"],
                "body": "Εκτελέστηκε η συνταγή μέσα στο επιτρεπόμενο παράθυρο;\n\nΜία ημερομηνία εκτός ορίου αρκεί. "
                        "Η πλατφόρμα τη βρίσκει όσο προλαβαίνεις να κάνεις κάτι.",
                "top": 380,
            },
            {
                "title": "02 · Έντυπη ή άυλη;",
                "highlight": ["02"],
                "body": "Η άυλη δεν χρειάζεται πρωτότυπο, υπογραφή ή σφραγίδα.\n\nΗ έντυπη τα χρειάζεται — μαζί με τη "
                        "γνωμάτευση όπου απαιτείται. Ο διαχωρισμός γίνεται αυτόματα, ανά συνταγή.",
                "top": 380,
            },
            {
                "title": "03 · Ταινίες γνησιότητας",
                "highlight": ["03"],
                "body": "Ταιριάζουν οι ταινίες με τις ποσότητες που εκτελέστηκαν;\n\nΈνας έλεγχος που στο χαρτί "
                        "κοστίζει ώρες και στην οθόνη δευτερόλεπτα.",
                "top": 380,
            },
            {
                "title": "04 · Διασταύρωση τιμολογίου",
                "highlight": ["04"],
                "body": "Συμφωνεί το σύνολο του τιμολογίου με το σύνολο των εκτελέσεων;\n\nΑν όχι, βλέπεις ακριβώς "
                        "πού χάνεται η διαφορά — πριν φύγει ο φάκελος.",
                "top": 380,
            },
            {
                "title": "05 · Ο φάκελος πριν φύγει",
                "highlight": ["05"],
                "body": "Για τις έντυπες: σκανάρεις τα barcode και η πλατφόρμα σου λέει ποια συνταγή λείπει από τον "
                        "φάκελο και ποια περισσεύει.\n\nΠριν την υποβολή. Όχι τρεις μήνες μετά.",
                "top": 360,
            },
            {
                "title": "Δεν θα κοπείς για κάτι που θα μπορούσες να είχες δει.",
                "highlight": ["δει"],
                "body": "RxVision — ανάλυση & συμμόρφωση για το φαρμακείο.\nΕλλάδα & Κύπρος · rxvision.gr\n\nΔοκιμή 14 ημερών, χωρίς κάρτα.",
                "title_size": 66,
                "top": 380,
            },
        ],
    },
}


def main() -> int:
    args = sys.argv[1:]
    slugs = list(POSTS) + list(DECKS) if not args or args[0] == "--all" else args
    for slug in slugs:
        if slug in POSTS:
            print(render(slug, POSTS[slug]))
        elif slug in DECKS:
            print(render_deck(slug, DECKS[slug]))
        else:
            print(f"unknown: {slug} (cards: {', '.join(POSTS)} · decks: {', '.join(DECKS)})")
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
