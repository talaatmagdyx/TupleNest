#!/usr/bin/env python3
"""Build the vector brand files in docs/brand from the mark and the bundled fonts.

Text is converted to outlines so the SVGs render the same everywhere (GitHub
shows SVGs as images, with no web fonts). Needs fontTools and brotli:
    pip install fonttools brotli
Run from the repository root:  python3 scripts/brand/make_brand.py
PNG versions are rendered afterwards by scripts/brand/make_brand.sh.
"""
import base64
import io
import re
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parents[2]
BRAND = ROOT / "docs" / "brand"
FONTS = ROOT / "docs" / "site" / "fonts"

NAVY, BLUE, HEAD, CELL = "#0B1F5C", "#1A6DFF", "#1A5FD0", "#B9CDF2"
WGHT = 600
DARK_NAVY = "#DCE6FA"  # navy strokes and "Tuple" on dark backgrounds


def font(name, wght):
    f = TTFont(FONTS / name)
    f = instancer.instantiateVariableFont(f, {"wght": wght})
    buf = io.BytesIO()
    f.flavor = None
    f.save(buf)
    return TTFont(io.BytesIO(buf.getvalue()))


def text_path(f, text, size, x, y, tracking=0.0):
    """Outline `text` with its baseline at (x, y). Returns (path d, advance)."""
    upm = f["head"].unitsPerEm
    cmap, gs, hmtx = f.getBestCmap(), f.getGlyphSet(), f["hmtx"]
    s = size / upm
    pen = SVGPathPen(gs)
    cx = 0.0
    for ch in text:
        g = cmap[ord(ch)]
        tp = TransformPen(pen, (s, 0, 0, -s, x + cx, y))
        gs[g].draw(tp)
        cx += hmtx[g][0] * s + tracking * size
    return pen.getCommands(), cx - tracking * size


def mark(navy=NAVY):
    """The 120x120 mark (same geometry as tuplenest-mark.svg)."""
    rows = []
    for j, y in enumerate((40, 54, 68)):
        for x in (34, 52.5, 71):
            rows.append(
                f'<rect x="{x}" y="{y}" width="15" height="10" rx="2" fill="{HEAD if j == 0 else CELL}"/>'
            )
    return (
        f'<path d="M16 80 V36 L60 10.5 L98 32.5" fill="none" stroke="{BLUE}" stroke-width="11" stroke-linejoin="round" stroke-linecap="round"/>'
        f'<path d="M104 44 V84 L60 109.5 L22 87.5" fill="none" stroke="{navy}" stroke-width="11" stroke-linejoin="round" stroke-linecap="round"/>'
        + "".join(rows)
    )


def logo(dark):
    navy = DARK_NAVY if dark else NAVY
    bold = font("SpaceGrotesk-latin-var.woff2", WGHT)
    size, base, x0 = 64, 82, 136
    t1, w1 = text_path(bold, "Tuple", size, x0, base, -0.01)
    t2, w2 = text_path(bold, "Nest", size, x0 + w1, base, -0.01)
    width = round(x0 + w1 + w2 + 6)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} 120" role="img" aria-label="TupleNest">'
        f"<title>TupleNest</title>{mark(navy)}"
        f'<path d="{t1}" fill="{navy}"/><path d="{t2}" fill="{BLUE}"/></svg>\n'
    )


def social(shot_href):
    """GitHub social preview, 1280x640. The screenshot is embedded."""
    bold = font("SpaceGrotesk-latin-var.woff2", WGHT)
    reg = font("Inter-latin-var.woff2", 500)
    t1, w1 = text_path(bold, "Tuple", 58, 150, 150, -0.01)
    t2, _ = text_path(bold, "Nest", 58, 150 + w1, 150, -0.01)
    h1, _ = text_path(bold, "The safety-first database", 44, 64, 262, -0.01)
    h2, _ = text_path(bold, "workspace for PostgreSQL", 44, 64, 316, -0.01)
    h3, _ = text_path(bold, "and SQLite.", 44, 64, 370, -0.01)
    sub, _ = text_path(reg, "Local-first. Open source. Built for confidence.", 22, 64, 430)
    url, _ = text_path(reg, "github.com/talaatmagdyx/TupleNest", 20, 64, 580)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1280" height="640" viewBox="0 0 1280 640">
<rect width="1280" height="640" fill="#F5F8FD"/>
<g transform="translate(56 92) scale(0.8)">{mark()}</g>
<path d="{t1}" fill="{NAVY}"/><path d="{t2}" fill="{BLUE}"/>
<path d="{h1}" fill="{NAVY}"/><path d="{h2}" fill="{NAVY}"/><path d="{h3}" fill="{NAVY}"/>
<path d="{sub}" fill="#3A4A70"/>
<rect x="64" y="470" width="56" height="5" rx="2.5" fill="{BLUE}"/>
<path d="{url}" fill="#5A6A8C"/>
<clipPath id="c"><rect x="660" y="64" width="680" height="512" rx="14"/></clipPath>
<rect x="656" y="60" width="688" height="520" rx="16" fill="#DDE5F3"/>
<image x="660" y="64" width="904" height="512" preserveAspectRatio="xMinYMin slice" xlink:href="{shot_href}" clip-path="url(#c)"/>
</svg>
"""


def main():
    (BRAND / "tuplenest-logo-light.svg").write_text(logo(False))
    (BRAND / "tuplenest-logo-dark.svg").write_text(logo(True))
    shot = ROOT / "docs" / "site" / "shots" / "screen-query-3.jpg"
    (BRAND / "social-preview.svg").write_text(social("data:image/jpeg;base64," + base64.b64encode(shot.read_bytes()).decode()))
    for p in BRAND.glob("*.svg"):
        assert re.search(r"<svg", p.read_text()), p


if __name__ == "__main__":
    main()
