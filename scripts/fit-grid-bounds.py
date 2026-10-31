"""Fits GRID_BOUNDS (shared/grid-map.js) for one floor: the grid rows/columns where the floor
plan SVG's 0-1 edges fall, chosen so the grid's wall cells land on the SVG's wall lines.
Run it again whenever a floor's grid (public/data/SPN*.txt) or SVG is regenerated, then copy
the printed top/bottom/left/right into GRID_BOUNDS and eyeball the overlay PNG
(black = SVG walls, red = grid walls, purple = both).

usage: python3 scripts/fit-grid-bounds.py <floor.svg> <grid.txt> <overlay.png> [top bottom left right]
Needs numpy and Pillow. The optional bounds skip the slow global search and only refine them.
"""
import re, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

svg_path, grid_path, out_png = sys.argv[1:4]
init = [float(v) for v in sys.argv[4:8]] if len(sys.argv) >= 8 else None

svg = open(svg_path).read()
vw, vh = [float(v) for v in re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg).groups()]
W = 2400; H = int(round(W * vh / vw))
img = Image.new('L', (W, H), 0)
draw = ImageDraw.Draw(img)
sx, sy = W / vw, H / vh

num = r'-?\d*\.?\d+(?:e-?\d+)?'
tok_re = re.compile(r'[MmLlCcQqZz]|' + num)
for d, cls in re.findall(r'<path d="([^"]*)" class="(C\d+)"', svg):
    if cls == 'C7': continue  # filled text glyphs, not walls
    toks = tok_re.findall(d); i = 0; cmd = None; x = y = 0.0; startx = starty = 0.0; pts = []
    def flush():
        global pts
        if len(pts) >= 2: draw.line([(px * sx, py * sy) for px, py in pts], fill=255, width=2)
        pts = []
    while i < len(toks):
        t = toks[i]
        if t.isalpha(): cmd = t; i += 1
        if cmd in 'Zz':
            if pts: pts.append((startx, starty)); flush()
            x, y = startx, starty; cmd = None; continue
        if cmd in 'Mm':
            nx, ny = float(toks[i]), float(toks[i + 1]); i += 2
            if cmd == 'm': nx += x; ny += y
            flush(); x, y = startx, starty = nx, ny; pts = [(x, y)]
            cmd = 'L' if cmd == 'M' else 'l'  # implicit line-tos follow
        elif cmd in 'Ll':
            nx, ny = float(toks[i]), float(toks[i + 1]); i += 2
            if cmd == 'l': nx += x; ny += y
            x, y = nx, ny; pts.append((x, y))
        elif cmd in 'Cc':
            v = [float(toks[i + k]) for k in range(6)]; i += 6
            if cmd == 'c': v = [v[k] + (x if k % 2 == 0 else y) for k in range(6)]
            for t_ in np.linspace(0, 1, 6)[1:]:
                bx = (1-t_)**3*x + 3*(1-t_)**2*t_*v[0] + 3*(1-t_)*t_**2*v[2] + t_**3*v[4]
                by = (1-t_)**3*y + 3*(1-t_)**2*t_*v[1] + 3*(1-t_)*t_**2*v[3] + t_**3*v[5]
                pts.append((bx, by))
            x, y = v[4], v[5]
        elif cmd in 'Qq':
            v = [float(toks[i + k]) for k in range(4)]; i += 4
            if cmd == 'q': v = [v[k] + (x if k % 2 == 0 else y) for k in range(4)]
            for t_ in np.linspace(0, 1, 5)[1:]:
                bx = (1-t_)**2*x + 2*(1-t_)*t_*v[0] + t_**2*v[2]
                by = (1-t_)**2*y + 2*(1-t_)*t_*v[1] + t_**2*v[3]
                pts.append((bx, by))
            x, y = v[2], v[3]
        else:
            raise SystemExit(f'unhandled token {t!r}')
    flush()

walls_img = np.array(img) > 0
dil = np.array(img.filter(ImageFilter.MaxFilter(5))) > 0  # tolerance of ~2 px (< 1 grid cell)

grid = np.array([[int(v) for v in line.split()] for line in open(grid_path) if line.strip()], dtype=np.uint8)
rows, cols = grid.shape
wr, wc = np.nonzero(grid)
print(f'svg {vw:.0f}x{vh:.0f} -> raster {W}x{H}; grid {rows}x{cols}, {len(wr)} wall cells')

def score(top, bottom, left, right):
    x = (wc - left) / (right - left); y = (wr - top) / (bottom - top)
    px = (x * W).astype(int); py = (y * H).astype(int)
    ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
    hits = dil[py[ok], px[ok]].sum()
    return hits / len(wr)


rng = np.random.default_rng(0)
sub = rng.choice(len(wr), 6000, replace=False)  # subsample for the coarse search
dil_coarse = np.array(img.filter(ImageFilter.MaxFilter(11))) > 0
def score_sub(top, bottom, left, right):
    x = (wc[sub] - left) / (right - left); y = (wr[sub] - top) / (bottom - top)
    px = (x * W).astype(int); py = (y * H).astype(int)
    ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
    return dil_coarse[py[ok], px[ok]].sum() / len(sub)

if init is None:  # coarse global search over all four bounds, step 10 cells
    cands = []
    for top in range(-60, 160, 10):
        for bottom in range(330, 580, 10):
            if bottom - top < 250: continue
            for left in range(-60, 140, 10):
                for right in range(700, 940, 10):
                    cands.append((score_sub(top, bottom, left, right), (top, bottom, left, right)))
    cands.sort(reverse=True)
    print('coarse top 3:', [(round(s, 3), b) for s, b in cands[:3]])
    seeds = [list(b) for _, b in cands[:5]]
else:
    seeds = [list(init)]

best, best_s = None, -1
for seed in seeds:
    cur, cur_s = list(seed), score(*seed)
    for step in [8, 4, 2, 1, 0.5, 0.25]:
        improved = True
        while improved:
            improved = False
            for k in range(4):
                for delta in (-step, step):
                    cand = list(cur); cand[k] += delta
                    s = score(*cand)
                    if s > cur_s + 1e-9: cur, cur_s, improved = cand, s, True
    if cur_s > best_s: best, best_s = cur, cur_s
print('FIT top/bottom/left/right =', [round(v, 2) for v in best], f'overlap {best_s:.1%}')

# overlay: svg walls black, grid walls red (purple where both)
top, bottom, left, right = best
ov = np.full((H, W, 3), 255, np.uint8); ov[walls_img] = (0, 0, 0)
x = (wc - left) / (right - left); y = (wr - top) / (bottom - top)
px = (x * W).astype(int); py = (y * H).astype(int)
ok = (px >= 0) & (px < W) & (py >= 0) & (py < H)
ov[py[ok], px[ok]] = np.where(walls_img[py[ok], px[ok]][:, None], (160, 0, 160), (255, 0, 0))
Image.fromarray(ov).save(out_png)
