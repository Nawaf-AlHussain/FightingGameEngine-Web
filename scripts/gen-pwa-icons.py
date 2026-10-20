#!/usr/bin/env python3
"""Generate PWA icons for Fighting Game Engine.

"SQUADRON COMIC" mark matching src/styles/game.css palette:
  --paper #f2ecda · --royal #3143d6 · --crimson #e8283c · --ink #101018
Composition: cream paper field (the site is a paper poster), slanted royal
panel (mirrors the site clip-path parallelogram), cream star with a crimson
misregistration offset — the lobby headline's own trick — hard ink shadow
under the panel, ink slash accent.

Outputs (512 design canvas, 4x supersampled):
  public/icons/icon-512.png          purpose "any"
  public/icons/icon-192.png          purpose "any"
  public/icons/icon-maskable-512.png purpose "maskable" (art in safe zone)
  public/icons/icon-maskable-192.png purpose "maskable"
  src/app/icon.png                   Next favicon convention
  src/app/apple-icon.png             Next apple-touch convention (180)
"""
import math
import os
from PIL import Image, ImageDraw

ROOT = '/home/z/my-project/FightingGameEngine-Web'
OUT = os.path.join(ROOT, 'public', 'icons')
APP = os.path.join(ROOT, 'src', 'app')
os.makedirs(OUT, exist_ok=True)
os.makedirs(APP, exist_ok=True)

PAPER = (242, 236, 218, 255)   # --paper  #f2ecda
ROYAL = (49, 67, 214, 255)     # --royal  #3143d6
CRIMSON = (232, 40, 60, 255)   # --crimson #e8283c
INK = (16, 16, 24, 255)        # --ink    #101018

SS = 4
S = 512 * SS  # working canvas 2048
CX = CY = S / 2


def shear_panel(half_w, half_h, shear):
    """Parallelogram like the site's clip-path: top edge shifted +s, bottom -s."""
    return [
        (CX - half_w + shear, CY - half_h),
        (CX + half_w + shear, CY - half_h),
        (CX + half_w - shear, CY + half_h),
        (CX - half_w - shear, CY + half_h),
    ]


def star_points(radius, rot_deg, ratio=0.45):
    r = radius * ratio
    pts = []
    for i in range(10):
        rad = math.radians(rot_deg - 90 + i * 36)
        rad_i = radius if i % 2 == 0 else r
        pts.append((CX + rad_i * math.cos(rad), CY + rad_i * math.sin(rad)))
    return pts


def offset(pts, dx, dy):
    return [(x + dx, y + dy) for x, y in pts]


def draw_art(k=1.0):
    """Render the mark at working resolution; k shrinks toward center (maskable)."""
    img = Image.new('RGBA', (S, S), PAPER)
    d = ImageDraw.Draw(img)

    def sc(pts):
        if k == 1.0:
            return pts
        return [(CX + (x - CX) * k, CY + (y - CY) * k) for x, y in pts]

    # Royal panel: hard ink shadow (the comic hard-offset-shadow voice),
    # then the royal slab
    panel = shear_panel(760, 450, 150)
    d.polygon(sc(offset(panel, 56, 56)), fill=INK)
    d.polygon(sc(panel), fill=ROYAL)

    # Cream star with crimson misregistration offset — the lobby headline's
    # own print-trick, so the icon and the title screen share one language
    star = star_points(460, -12)
    d.polygon(sc(offset(star, 44, 44)), fill=CRIMSON)
    d.polygon(sc(star), fill=PAPER)

    # Ink slash accent, upper-left, overlapping the panel edge
    ax, ay = CX - 620, CY - 640
    slash = [
        (ax + 60, ay),
        (ax + 400, ay),
        (ax + 340, ay + 120),
        (ax, ay + 120),
    ]
    d.polygon(sc(slash), fill=INK)

    return img


def save(img, path, size):
    img.resize((size, size), Image.LANCZOS).convert('RGB').save(path, 'PNG', optimize=True)
    print(f'wrote {path} ({size}x{size})')


any512 = draw_art(k=1.0).resize((512, 512), Image.LANCZOS)
mask512 = draw_art(k=0.70).resize((512, 512), Image.LANCZOS)

save(any512, os.path.join(OUT, 'icon-512.png'), 512)
save(any512, os.path.join(OUT, 'icon-192.png'), 192)
save(any512, os.path.join(APP, 'icon.png'), 512)
save(any512, os.path.join(APP, 'apple-icon.png'), 180)
save(mask512, os.path.join(OUT, 'icon-maskable-512.png'), 512)
save(mask512, os.path.join(OUT, 'icon-maskable-192.png'), 192)

print('done')
