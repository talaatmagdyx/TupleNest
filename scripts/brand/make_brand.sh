#!/bin/bash
# Render the brand PNGs from the SVGs. Needs rsvg-convert (librsvg) and
# ImageMagick. Run from the repository root after make_brand.py.
set -euo pipefail
B=docs/brand
S=docs/site
python3 scripts/brand/make_brand.py

rsvg-convert -h 240 "$B/tuplenest-logo-light.svg" -o "$B/tuplenest-logo-light.png"
rsvg-convert -h 240 "$B/tuplenest-logo-dark.svg"  -o "$B/tuplenest-logo-dark.png"
rsvg-convert -w 512 -h 512 "$B/tuplenest-mark.svg" -o "$B/tuplenest-mark-512.png"

# Social preview (the screenshot is embedded in the SVG).
rsvg-convert --unlimited -w 1280 -h 640 "$B/social-preview.svg" | magick - -strip -quality 90 "$B/social-preview.png"
rm "$B/social-preview.svg"  # only an intermediate; the PNG is the asset

# Favicons for the site.
rsvg-convert -w 32 -h 32   "$B/tuplenest-icon.svg" -o "$S/favicon-32.png"
rsvg-convert -w 180 -h 180 "$B/tuplenest-icon.svg" -o "$S/apple-touch-icon.png"
magick "$S/favicon-32.png" \( "$B/tuplenest-icon.svg" -background none -resize 16x16 \) "$S/favicon.ico"
