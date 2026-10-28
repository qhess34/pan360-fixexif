"""Scène de rue synthétique en projection équirectangulaire (ray casting numpy).

Sert aux tests (tests/fixtures) et aux captures d'écran du README : la géométrie est connue,
on peut donc vérifier qu'une correction calculée par l'app est exacte.

Usage : python3 tools/scene.py SORTIE.jpg PITCH ROLL [LARGEUR] [CHAMP]
  PITCH / ROLL : inclinaison simulée de la caméra, en degrés.
  La correction Panoramax attendue est alors pitch = -PITCH, roll = -ROLL.
  CHAMP : si fourni, photo à plat (caméra perspective) de CHAMP degrés de large, format 4:3,
  au lieu d'un panorama équirectangulaire 360°.

Repère : x à droite, y en haut, z vers l'avant ; caméra à 2,2 m du sol.
Poteaux verticaux (rayon 0,12 m, hauteur 6 m) en x = ±5,5 et z = -60…60 tous les 12 m ;
façades en x = ±9.
"""
import sys
import warnings
import numpy as np
from PIL import Image, ImageFilter

warnings.filterwarnings("ignore", category=RuntimeWarning)  # divisions par 0 attendues (rayons parallèles)

out = sys.argv[1]
tilt_pitch, tilt_roll = float(sys.argv[2]), float(sys.argv[3])
W = int(sys.argv[4]) if len(sys.argv) > 4 else 4096
flat_fov = float(sys.argv[5]) if len(sys.argv) > 5 else None
if flat_fov:
    # Caméra perspective (sténopé) : z vers l'avant, distance focale déduite du champ horizontal
    H = W * 3 // 4
    f = (W / 2) / np.tan(np.radians(flat_fov) / 2)
    X, Y = np.meshgrid(np.arange(W) + .5 - W / 2, H / 2 - (np.arange(H) + .5))
    d = np.stack([X / f, Y / f, np.ones_like(X)], -1)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
else:
    H = W // 2
    u = (np.arange(W) + .5) / W; v = (np.arange(H) + .5) / H
    lon = (u - .5) * 2 * np.pi            # 0 = avant (+z)
    lat = (.5 - v) * np.pi
    LON, LAT = np.meshgrid(lon, lat)
    d = np.stack([np.cos(LAT) * np.sin(LON), np.sin(LAT), np.cos(LAT) * np.cos(LON)], -1)  # x droite, y haut, z avant
# caméra inclinée : on tourne les rayons (roll autour de z, pitch autour de x)
def rot(a, axis):
    a = np.radians(a); c, s = np.cos(a), np.sin(a)
    return {'x': np.array([[1,0,0],[0,c,-s],[0,s,c]]), 'z': np.array([[c,-s,0],[s,c,0],[0,0,1]])}[axis]
R = rot(tilt_pitch, 'x') @ rot(tilt_roll, 'z')
d = d @ R.T
dx, dy, dz = d[...,0], d[...,1], d[...,2]
cam_h = 2.2
img = np.zeros((H, W, 3))
# ciel
t = np.clip(dy, 0, 1)[..., None]
img[:] = (1 - t) * np.array([200, 222, 240]) + t * np.array([70, 130, 200])
best = np.full((H, W), np.inf)
# sol
with np.errstate(divide='ignore', invalid='ignore'):
    tg = np.where(dy < -1e-4, -cam_h / dy, np.inf)
gx, gz = dx * tg, dz * tg
ground = np.isfinite(tg)
road = ground & (np.abs(gx) < 4)
side = ground & ~road
col = np.zeros((H, W, 3))
col[side] = [150, 150, 140]
col[road] = [70, 72, 75]
dash = road & (np.abs(gx) < .12) & ((np.floor(gz / 3) % 2) == 0)
col[dash] = [235, 235, 225]
edge = ground & (np.abs(np.abs(gx) - 4) < .12)
col[edge] = [200, 200, 195]
pav = side & ((np.floor(gx * 1.2) + np.floor(gz * 1.2)) % 2 == 0)
col[pav] = [160, 158, 150]
m = ground & (tg < best); img[m] = col[m]; best[m] = tg[m]
# immeubles : façades à x = ±9, découpées en blocs le long de z
rng = np.random.default_rng(3)
for sgn in (-1, 1):
    with np.errstate(divide='ignore', invalid='ignore'):
        tw = np.where(dx * sgn > 1e-4, (9 * sgn) / dx, np.inf)
    wz, wy = dz * tw, cam_h + dy * tw
    blk = np.floor(wz / 14)
    hgt = 8 + (np.abs(np.sin(blk * 12.9898 + sgn * 78.233)) * 10)
    hit = np.isfinite(tw) & (wy >= 0) & (wy < hgt) & (np.abs(wz) < 200) & (tw < best)
    base = np.stack([150 + 60 * np.abs(np.sin(blk * 3.1 + sgn)), 130 + 50 * np.abs(np.sin(blk * 1.7)), 110 + 40 * np.abs(np.cos(blk * 2.3))], -1)
    c = base.copy()
    fz = (wz % 14) / 14; fy = wy % 3
    win = (fy > 1) & (fy < 2.3) & (((wz % 2.3) / 2.3) > .3) & (((wz % 2.3) / 2.3) < .8) & (fz > .08) & (fz < .92) & (wy > 3)
    c[win] = [60, 80, 105]
    door = (wy < 2.4) & (((wz % 14) > 5.5) & ((wz % 14) < 7))
    c[door] = [80, 55, 40]
    corner = (fz < .02) | (fz > .98)
    c[corner] = base[corner] * .6
    img[hit] = c[hit]; best[hit] = tw[hit]
# poteaux (cylindres verticaux) le long des trottoirs
for pz in range(-60, 61, 12):
    for px in (-5.5, 5.5):
        ox, oz = -px, -pz
        a = dx**2 + dz**2; b = 2 * (ox * dx + oz * dz); cc = ox**2 + oz**2 - .12**2
        disc = b * b - 4 * a * cc
        with np.errstate(invalid='ignore', divide='ignore'):
            tp = np.where(disc > 0, (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a), np.inf)
        py = cam_h + dy * tp
        hit = (tp > 0) & (py >= 0) & (py < 6) & (tp < best)
        img[hit] = [45, 50, 55]; best[hit] = tp[hit]
# brume légère avec la distance
fog = np.clip((np.where(np.isfinite(best), best, 400) - 20) / 300, 0, .55)[..., None]
img = img * (1 - fog) + np.array([200, 215, 230]) * fog
Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.SMOOTH).save(out, quality=85)
print('ok', out)
