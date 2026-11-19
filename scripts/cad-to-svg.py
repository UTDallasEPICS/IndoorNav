"""Export the navigation-relevant layers of a floor-plan DXF to SVG, plus a
JSON list of rooms (number, name and position on the SVG).

Usage:
  dwg2dxf -y -o cad-source/SPN-level-1.dxf cad-source/SPN-level-1.dwg
  python3 scripts/cad-to-svg.py cad-source/SPN-level-1.dxf \
      public/maps/spn-level1.svg public/maps/spn-level1-rooms.json
  (same for level 2, with spn-level2.*)
"""
import json
import re
import sys

from ezdxf import bbox, disassemble, path, recover
from ezdxf.enums import TextEntityAlignment
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg
from shapely.affinity import translate
from shapely.geometry import LineString, Polygon
from shapely.ops import polygonize, unary_union
from shapely.prepared import prep

# Only these layers end up in the map; dimensions, furniture, square-footage
# labels, etc. are left out to keep the SVG small and readable on a phone.
KEEP_LAYERS = {
    "ENTOS-BASE-SHELL",
    "A-EXT FOOTPRINT",
    "A-EXT WINDOW",
    "A-INT WALL OUTLINE",
    "A-GLASS WALLED AREA",
    "A-GLAZ",
    "A-GLAZ-MULL",
    "A-CONCRETE",
    "A-SHAFT",
    "A-STAIR",
    "A-DOOR",
    # Level 2 names its layers differently
    "A-EXST",  # exterior walls, columns, atrium edge
    "A-STAIRS",
    "A-FLOR",
    "A-GLAZ-CWMG",  # curtain wall
    "A-ROOM NUMBER",
}

# Not drawn, to keep the map uncluttered (find_rooms still reads the names for search),
# but still counted in the map's frame so room positions and the route grid line up as before.
FRAME_ONLY_LAYERS = {"A-ROOM NAME"}

# A room name counts as belonging to a room number if it is this close (in
# drawing units, inches) to the number's label.
NAME_DISTANCE = 75


def text_of(entity):
    raw = entity.plain_text() if entity.dxftype() == "MTEXT" else entity.dxf.text
    return " ".join(raw.split())


def center_of(entity):
    box = bbox.extents([entity])
    return box.center.x, box.center.y


def find_rooms(msp):
    """Pairs each room-number label with the room-name label(s) above it.

    Returns (rooms, leaders): leaders are the matches made by move_to_leader_dots.
    """
    rooms = [
        {"number": text_of(e), "names": [], "x": box.center.x, "y": box.center.y, "label": e, "label_box": box}
        for e in msp.query('TEXT MTEXT[layer=="A-ROOM NUMBER"]')
        for box in [bbox.extents([e])]
    ]

    # Names sit just above their number, sometimes split over several labels.
    # Each name label goes only to the closest number below it, so a name is
    # never shared between neighbouring rooms.
    for e in msp.query('TEXT MTEXT[layer=="A-ROOM NAME"]'):
        x, y = center_of(e)
        below = [r for r in rooms if 0 < y - r["y"] < NAME_DISTANCE and abs(x - r["x"]) < NAME_DISTANCE * 2]
        if below:
            closest = min(below, key=lambda r: (x - r["x"]) ** 2 + (y - r["y"]) ** 2)
            closest["names"].append((y, text_of(e)))

    for room in rooms:
        # Top line first
        room["name"] = " ".join(text for _, text in sorted(room.pop("names"), reverse=True))

    leaders = move_to_leader_dots(msp, rooms)  # after the names (they're matched to the text), before the outlines (found from the position)
    add_outlines(msp, rooms)
    return rooms, leaders


# ============================================================================================
# LEADERS: small rooms whose number is written outside the room
#
# When a room is too small for its number, the drawing puts the number outside and draws a
# leader line from the number to a dot inside the room. The script then:
#   1. uses the DOT as the room's position (inside the room), so routes and the destination
#      pin don't end on the text (move_to_leader_dots), and
#   2. redraws the map with the number moved onto the dot at LEADER_TEXT_SCALE of its size,
#      and the leader line and dot removed (put_labels_in_rooms).
#
# REQUIRED CAD FORMAT (check this when converting a new floor or building):
#   - The leader is an ARC, LINE or open LWPOLYLINE on the LEADER_LAYER layer.
#   - One end of it touches (within END_TO_LABEL) the room-number text it belongs to.
#   - The other end touches (within END_TO_DOT) the dot: a small closed LWPOLYLINE or a
#     CIRCLE, at most DOT_MAX_SIZE across, on the same layer, placed inside the room.
#
# Leaders drawn any other way (another layer, CAD's LEADER/MULTILEADER objects, hatched dots)
# are NOT matched: those rooms keep the text position. The script prints a report on every run;
# if it says some leaders are unmatched, check how this drawing draws them and extend
# leader_ends() / find_dots() below.
# ============================================================================================

LEADER_LAYER = "A-ROOM NUMBER"  # SPN draws leaders and dots on the room-number layer
DOT_MAX_SIZE = 20  # inches across; SPN's dots are about 12
END_TO_DOT = 15  # inches from the leader's end to the dot's centre
END_TO_LABEL = 30  # inches from the leader's other end to the edge of the number text
LEADER_TEXT_SCALE = 0.6  # size of a moved number compared with the original, so it fits in the small room


def leader_ends(entity):
    """The two end points of a possible leader, or None if the entity can't be one."""
    kind = entity.dxftype()
    if kind == "ARC":
        return entity.start_point, entity.end_point
    if kind == "LINE":
        return entity.dxf.start, entity.dxf.end
    if kind == "LWPOLYLINE" and not entity.closed and len(entity) >= 2:  # closed ones are dots
        points = entity.get_points("xy")
        return points[0], points[-1]
    return None


def find_dots(entities):
    """The small dots that leaders point to, as (entity, (x, y) of its centre)."""
    dots = []
    for e in entities:
        if e.dxftype() == "CIRCLE" and e.dxf.radius * 2 <= DOT_MAX_SIZE:
            dots.append((e, (e.dxf.center.x, e.dxf.center.y)))
        elif e.dxftype() == "LWPOLYLINE" and e.closed:
            box = bbox.extents([e])
            if max(box.size.x, box.size.y) <= DOT_MAX_SIZE:
                dots.append((e, (box.center.x, box.center.y)))
    return dots


def distance_to_box(x, y, box):
    """How far (x, y) is from a bounding box; 0 if it's inside."""
    dx = max(box.extmin.x - x, 0, x - box.extmax.x)
    dy = max(box.extmin.y - y, 0, y - box.extmax.y)
    return (dx * dx + dy * dy) ** 0.5


def move_to_leader_dots(msp, rooms):
    """Moves each room that has a leader to the leader's dot, and prints how many matched.

    Returns the matches as (number text entity, leader entity, dot entity, (x, y) of the dot).
    """
    entities = list(msp.query(f'*[layer=="{LEADER_LAYER}"]'))
    dots = find_dots(entities)
    matches, unmatched = [], 0

    for e in entities:
        ends = leader_ends(e)
        if not ends:
            continue
        best = None  # (how far off both ends are, room, (dot entity, dot centre))
        for (dot_end, label_end) in (ends, ends[::-1]):  # either end can be the dot end
            if not dots:
                break
            dot = min(dots, key=lambda d: (d[1][0] - dot_end[0]) ** 2 + (d[1][1] - dot_end[1]) ** 2)
            to_dot = ((dot[1][0] - dot_end[0]) ** 2 + (dot[1][1] - dot_end[1]) ** 2) ** 0.5
            room = min(rooms, key=lambda r: distance_to_box(label_end[0], label_end[1], r["label_box"]))
            to_label = distance_to_box(label_end[0], label_end[1], room["label_box"])
            if to_dot <= END_TO_DOT and to_label <= END_TO_LABEL and (best is None or to_dot + to_label < best[0]):
                best = (to_dot + to_label, room, dot)
        if best:
            _, room, (dot_entity, centre) = best
            room["x"], room["y"] = centre
            matches.append((room["label"], e, dot_entity, centre))
        else:
            unmatched += 1

    for room in rooms:
        del room["label_box"], room["label"]  # only needed for matching
    print(f"leaders: {len(matches)} matched (rooms moved to their dot), {unmatched} unmatched"
          + (" <- check REQUIRED CAD FORMAT in cad-to-svg.py" if unmatched else ""))
    return matches


def put_labels_in_rooms(msp, matches):
    """For the map picture: moves each matched number onto its dot, smaller, and removes the leader and dot.

    Changes the drawing in memory only (the DXF file isn't saved); run after the map's frame is measured,
    so a moved label can't change the frame.
    """
    for label, leader, dot, (x, y) in matches:
        if label.dxftype() == "MTEXT":
            label.dxf.char_height *= LEADER_TEXT_SCALE
            label.dxf.insert = (x, y, 0)
            label.dxf.attachment_point = 5  # 5 = middle centre: the text is centred on the dot
            label.dxf.width = 0  # no wrapping box, so it stays on one line
        else:  # TEXT
            label.dxf.height *= LEADER_TEXT_SCALE
            label.set_placement((x, y), align=TextEntityAlignment.MIDDLE_CENTER)
        msp.delete_entity(leader)
        msp.delete_entity(dot)

# ============================================================================================
# END OF LEADERS
# ============================================================================================


# ============================================================================================
# WALL FILL: solid walls instead of two thin lines, and no column squares
#
# The drawing shows a wall as its two faces (two parallel lines) with nothing between them.
# Some walls are one closed shape, but most are loose lines that only look closed, so the
# script joins every wall line into closed shapes and fills the thin ones:
#   - thin shape (under WALL_MAX_THICKNESS) = the inside of a wall or window -> filled;
#   - wide shape = a room or shaft -> left empty. Rooms are open at their doorways, so they
#     are almost never closed shapes anyway: the fill can't end up on the wrong side.
# Columns (small squares, COLUMN_MIN to COLUMN_MAX across) are taken out of the picture when
# REMOVE_COLUMNS is True: their outlines are deleted and they get no fill.
#   - Free-standing column: simply gone.
#   - Column that walls run into: gone, and the walls are carried on through the space it
#     leaves (a wall that passed "through" it is joined up again; walls that met at it still
#     meet), so removing it never leaves a gap that looks like a doorway.
#   - Column the wall is drawn wrapped around (the wall's own outline goes around it): kept,
#     filled like the wall, because its box is part of the wall's shape, not a separate square.
#
# Only the picture changes. The route grid (public/data/SPN-level<N>.txt) is a separate file,
# so columns still block routes.
#
# REQUIRED CAD FORMAT: wall and window lines are on WALL_LAYERS and meet end to end. A wall
# drawn as two lines with open ends (common at doorways) is closed by the script if the two
# loose ends are within WALL_END_GAP of each other; a bigger gap leaves that wall hollow.
# ============================================================================================

WALL_LAYERS = KEEP_LAYERS - {"A-ROOM NUMBER", "A-DOOR", "A-STAIR", "A-STAIRS", "A-FLOR"}  # walls, columns, windows and glass (one fill colour for all)
DOOR_LAYERS = {"A-DOOR"}  # loose door-frame lines close the end of a wall at a doorway; the doors themselves are never filled
WALL_MAX_THICKNESS = 24  # inches: a closed shape thinner than this is a wall
WALL_FILL = "#55565e"  # dark grey, under the black lines
WALL_END_GAP = 10  # inches: two loose line ends this close are the two faces of one wall, so its end is closed
REMOVE_COLUMNS = True  # False: every column stays on the map, filled like a wall
REDRAW_WALLS = False  # True: the script draws the walls itself (see redraw_walls) instead of using the drawing's wall lines, so every box can be cut off
COLUMN_MIN, COLUMN_MAX = 12, 30  # inches across; SPN's columns are 16 to 20
COLUMN_WALL_GAP = 6  # inches: a column with a wall line this close is built into that wall (the wall is often drawn wrapping around it)
CURVES = ("LINE", "LWPOLYLINE", "POLYLINE", "ARC", "CIRCLE", "ELLIPSE", "SPLINE")


def stroke_of(entity):
    """The entity as a line (curves become short straight pieces), or None if it has no length."""
    try:
        points = [(round(v.x, 2), round(v.y, 2)) for v in path.make_path(entity).flattening(0.5)]
    except Exception:  # a broken entity in the drawing: skip it
        return None
    return LineString(points) if len(points) >= 2 and LineString(points).length > 0 else None


def is_column(shape):
    """Is this closed shape a small solid square (at any angle)?"""
    box = shape.minimum_rotated_rectangle  # the tightest rectangle around it, turned to fit
    if box.geom_type != "Polygon":
        return False
    (x1, y1), (x2, y2), (x3, y3) = box.exterior.coords[:3]
    a, b = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5, ((x3 - x2) ** 2 + (y3 - y2) ** 2) ** 0.5
    return (COLUMN_MIN <= min(a, b) and max(a, b) <= COLUMN_MAX and abs(a - b) <= 0.2 * max(a, b)
            and shape.area >= 0.9 * box.area)  # 0.9: fills its rectangle, so an L or a triangle isn't a column


def end_caps(lines):
    """Short lines that close open wall ends: each loose line end is joined to the nearest other loose end.

    `lines` must already be cut where they cross (unary_union does that), so an end that touches
    another line isn't loose.
    """
    uses = {}  # end point -> how many line pieces end there
    for line in lines:
        for point in (line.coords[0], line.coords[-1]):
            uses[point] = uses.get(point, 0) + 1
    loose = [point for point, count in uses.items() if count == 1]
    cells = {}  # loose ends bucketed in WALL_END_GAP squares, so only neighbours are compared
    for x, y in loose:
        cells.setdefault((int(x // WALL_END_GAP), int(y // WALL_END_GAP)), []).append((x, y))
    caps = set()
    for x, y in loose:
        cx, cy = int(x // WALL_END_GAP), int(y // WALL_END_GAP)
        near = [
            (((x - ox) ** 2 + (y - oy) ** 2) ** 0.5, (ox, oy))
            for dx in (-1, 0, 1) for dy in (-1, 0, 1)
            for ox, oy in cells.get((cx + dx, cy + dy), [])
            if (ox, oy) != (x, y)
        ]
        if near and min(near)[0] <= WALL_END_GAP:
            caps.add(tuple(sorted([(x, y), min(near)[1]])))  # sorted: A-B and B-A are the same cap
    return [LineString(cap) for cap in caps]


def carry_walls_through(column, fills):
    """The pieces of wall to draw inside a removed column, so the walls that ran into it stay joined.

    Each wall end touching the column is stretched straight across it, then cut back to where it
    meets another stretched wall: a wall through the column is joined up, walls meeting at it form
    a T or a corner, and a single wall that just ended at the column is left ending there.
    """
    box = column.minimum_rotated_rectangle.exterior.coords
    (x0, y0), (x1, y1), (x2, y2) = box[0], box[1], box[2]
    centre = column.centroid
    sides = []  # the column's two directions: (unit vector, half the column's size that way)
    for (ax, ay), (bx, by) in (((x0, y0), (x1, y1)), ((x1, y1), (x2, y2))):
        length = ((bx - ax) ** 2 + (by - ay) ** 2) ** 0.5
        sides.append((((bx - ax) / length, (by - ay) / length), length / 2))

    area = column.buffer(0.5)
    ring = area.buffer(1.5).difference(area)  # a thin band just outside the column: where walls touch it
    touching = unary_union([f for f in fills if f.intersects(ring)]).intersection(ring)
    ends = [g for g in getattr(touching, "geoms", [touching]) if g.geom_type == "Polygon" and not g.is_empty]

    bands = []  # (wall end, that end stretched straight across the column)
    for end in ends:
        rx, ry = end.centroid.x - centre.x, end.centroid.y - centre.y
        along = [(rx * ux + ry * uy) / half for (ux, uy), half in sides]  # how far out the end is, in each direction
        i = 0 if abs(along[0]) > abs(along[1]) else 1  # the direction the wall comes in from
        (ux, uy), half = sides[i]
        (wx, wy), other_half = sides[1 - i]
        across = [x * wx + y * wy for x, y in end.exterior.coords]
        if max(across) - min(across) > 0.7 * 2 * other_half:
            continue  # as wide as the column's side: a wall running past the column, not one ending at it
        sign = -1 if along[i] > 0 else 1  # stretch back towards (and past) the column
        reach = 2 * half + 4
        bands.append((end, end.union(translate(end, sign * ux * reach, sign * uy * reach)).convex_hull))

    pieces = []
    limit = area.buffer(1.5)
    for end, band in bands:
        others = unary_union([b for e, b in bands if e is not end])
        meeting = band.intersection(others)  # where this wall crosses another one
        if not meeting.is_empty:
            pieces.append(end.union(meeting).convex_hull.intersection(limit))
    return pieces


def parts_of(shape):
    """The separate polygons in a shapely result (which may be one polygon, many, or a mix with lines)."""
    return [g for g in getattr(shape, "geoms", [shape]) if g.geom_type == "Polygon" and not g.is_empty]


def is_box(shape):
    """Is this thick lump of wall about the size of a column? Looser than is_column: a column on a wall comes out as a rectangle."""
    box = shape.minimum_rotated_rectangle
    if box.geom_type != "Polygon":
        return False
    (x1, y1), (x2, y2), (x3, y3) = box.exterior.coords[:3]
    a, b = ((x2 - x1) ** 2 + (y2 - y1) ** 2) ** 0.5, ((x3 - x2) ** 2 + (y3 - y2) ** 2) ** 0.5
    return COLUMN_MIN - 1 <= min(a, b) and max(a, b) <= COLUMN_MAX + 10 and shape.area >= 0.8 * box.area


def redraw_walls(msp, thin, columns, deletable):
    """REDRAW_WALLS: returns the walls as shapes the script draws itself (fill + outline), with every box cut off.

    All the filled wall shapes and columns are merged into one "wall mass". Anywhere the mass is
    thicker than COLUMN_MIN and about column-sized is a box: it is cut out, and the walls that ran
    into it are carried on through the hole. The drawing's own lines that lie on the old mass are
    deleted, since the script's outline replaces them; lines elsewhere (doors, stairs, single-line
    partitions, anything too wide to be a wall) are still drawn from the drawing.
    """
    mass = unary_union(thin + columns)
    r = COLUMN_MIN / 2
    thick = mass.buffer(-r, join_style=2).buffer(r + 0.5, join_style=2).intersection(mass)  # shrink then grow back: only parts thicker than COLUMN_MIN survive
    boxes = [g for g in parts_of(thick) if is_box(g)]
    rest = mass.difference(unary_union(boxes).buffer(0.3, join_style=2)) if boxes else mass
    joins = [piece for box in boxes for piece in carry_walls_through(box, parts_of(rest))]
    walls = parts_of(unary_union([rest] + joins).buffer(0.2, join_style=2).buffer(-0.2, join_style=2))  # grow/shrink a hair: closes hairline cracks between pieces

    on_mass = prep(mass.buffer(0.4))
    gone = 0
    for entity, line in deletable:
        if entity.is_alive and on_mass.contains(line):
            msp.delete_entity(entity)
            gone += 1
    print(f"walls redrawn: {len(walls)} wall shapes, {len(boxes)} boxes cut off ({len(joins)} wall joins), "
          f"{gone} of the drawing's wall lines replaced")
    # Where a box was: painted white over the drawing's lines, in case a line that also runs elsewhere still traces it.
    wall_area = unary_union(walls).buffer(0.5)
    patches = [part for box in boxes for part in parts_of(box.buffer(1.5, join_style=2).difference(wall_area))]
    return walls, patches


def fill_walls(msp):
    """Returns (wall shapes, joining pieces) to fill and deletes the columns from the drawing.

    Changes the drawing in memory only; run after the map's frame is measured.
    """
    walls, doors, deletable, columns = [], [], [], []
    for top in list(msp):
        layer = top.dxf.layer
        if layer not in WALL_LAYERS | DOOR_LAYERS:
            continue
        if top.dxftype() == "HATCH":  # a solid-filled area; a column-sized one is a column
            try:
                shapes = [Polygon([(v.x, v.y) for v in p.flattening(0.5)]) for p in path.from_hatch(top)]
            except Exception:
                continue
            if layer in WALL_LAYERS and len(shapes) == 1 and shapes[0].is_valid and is_column(shapes[0]):
                columns.append(shapes[0])
                deletable.append((top, shapes[0]))  # deleted below, if the column stands free
            continue
        for e in disassemble.recursive_decompose([top]):  # also looks inside blocks (INSERT)
            line = stroke_of(e) if e.dxftype() in CURVES else None
            if line is None:
                continue
            (doors if layer in DOOR_LAYERS else walls).append(line)
            if e is top and layer in WALL_LAYERS:
                deletable.append((top, line))  # a column's own outline is deleted below

    joined = unary_union(walls + doors)  # one set of lines, cut wherever they cross
    pieces = list(joined.geoms) if hasattr(joined, "geoms") else [joined]
    shapes = list(polygonize(unary_union(pieces + end_caps(pieces))))  # every closed shape the lines make
    columns += [Polygon(s.exterior) for s in shapes if is_column(Polygon(s.exterior))]  # exterior: a square drawn with a second square inside it still counts

    def is_wall(shape):
        if not shape.buffer(-WALL_MAX_THICKNESS / 2).is_empty:  # still something left after shrinking: too wide for a wall
            return False
        if door_lines is not None and shape.boundary.intersection(door_lines).length > 0.5 * shape.boundary.length:
            return False  # mostly door lines: a door leaf, not a wall
        return True

    door_lines = unary_union(doors).buffer(0.3) if doors else None
    thin = [s for s in shapes if is_wall(s)]
    if REDRAW_WALLS:
        return redraw_walls(msp, thin, [c for c in columns if c.is_valid], deletable)

    column_area, seen, in_walls, removed, kept = [], [], [], 0, 0
    for column in sorted(columns, key=lambda c: -c.area):  # biggest first: a square inside a square goes with the outer one
        if any(column.representative_point().within(other) for other in seen):
            continue  # the same column found twice (its solid fill and its outline)
        area = column.buffer(0.5)  # 0.5 inch of slack
        seen.append(area)
        own = [(entity, line) for entity, line in deletable if entity.is_alive and line.within(area)]
        own_lines = {id(line) for _, line in own}
        if not REMOVE_COLUMNS:
            kept += 1
            continue
        others = unary_union([line for line in walls if id(line) not in own_lines and line.intersects(area)])
        traced = column.exterior.intersection(others.buffer(0.6)).length  # how much of the column's outline other lines run along
        if traced > 0.4 * column.exterior.length:
            kept += 1  # other lines trace about 2+ of its sides (it's drawn as part of a wall's outline): removing it would leave an empty box
            continue
        near = column.buffer(COLUMN_WALL_GAP)
        if any(id(line) not in own_lines and line.intersects(near) for line in walls):  # a wall line is close: not free-standing
            around = near.difference(column)  # the band around the column
            wrap = unary_union([s for s in thin if s.intersects(around) and not s.representative_point().within(area)])
            if wrap.intersection(around).area > 0.6 * around.area:
                kept += 1  # the wall is drawn wrapped around it: stays, filled like the wall
                continue
            in_walls.append(column)
        for entity, _ in own:
            msp.delete_entity(entity)
        column_area.append(area)
        removed += 1
    column_area = unary_union(column_area)

    fills = [s for s in thin if not s.representative_point().within(column_area)]
    joins = [piece for column in in_walls for piece in carry_walls_through(column, fills)]
    joins = unary_union(joins)  # one shape per joined-up area, so overlapping pieces don't cancel out in the SVG
    joins = [g for g in getattr(joins, "geoms", [joins]) if g.geom_type == "Polygon" and not g.is_empty]
    print(f"walls: {len(fills)} shapes filled, {len(shapes) - len(fills)} left empty; "
          f"columns: {removed} removed ({len(in_walls)} of them out of a wall, {len(joins)} wall joins drawn), "
          f"{kept} kept (drawn as part of a wall)")
    return fills, joins

# ============================================================================================
# END OF WALL FILL
# ============================================================================================


def contains(polygon, x, y):
    """Ray casting: is (x, y) inside the polygon (a list of (x, y) points)?"""
    inside = False
    for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def area_of(polygon):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(polygon, polygon[1:] + polygon[:1]))) / 2


def add_outlines(msp, rooms):
    """Gives each room its boundary from the A-SQ FOOTAGE layer (the area outlines).

    A room gets the smallest outline around its number label. An outline that
    holds labels of different rooms is ambiguous (labels sometimes sit in a
    neighbouring room), so none of those rooms get it rather than a wrong one.
    """
    outlines = [
        [(v.x, v.y) for v in path.make_path(e).flattening(1)]  # 1 inch: smooth enough for curved walls
        for e in msp.query('LWPOLYLINE[layer=="A-SQ FOOTAGE"]')
        if e.closed
    ]

    for room in rooms:
        around = [o for o in outlines if contains(o, room["x"], room["y"])]
        room["outline"] = min(around, key=area_of) if around else None

    # Count first, then clear, so clearing one room doesn't hide it from the next check
    numbers_in = {}  # id(outline) -> room numbers whose label is inside it
    for room in rooms:
        if room["outline"]:
            numbers_in.setdefault(id(room["outline"]), set()).add(room["number"])
    for room in rooms:
        if room["outline"] and len(numbers_in[id(room["outline"])]) > 1:
            room["outline"] = None


def main(src, svg_dst, rooms_dst=None):
    doc, _ = recover.readfile(src)
    msp = doc.modelspace()

    cfg = config.Configuration(
        background_policy=config.BackgroundPolicy.WHITE,
        color_policy=config.ColorPolicy.BLACK,
        lineweight_policy=config.LineweightPolicy.RELATIVE,
    )

    def render(layers):
        backend = svg.SVGBackend()
        Frontend(RenderContext(doc), backend, config=cfg).draw_layout(
            msp, filter_func=lambda e: e.dxf.layer in layers
        )
        return backend

    # The frame (page size 0 = fit to the extents) includes FRAME_ONLY_LAYERS, so dropping
    # their text doesn't shrink the page and shift every position. Measured before any
    # label is moved, for the same reason.
    content = render(KEEP_LAYERS | FRAME_ONLY_LAYERS).player().bbox()

    rooms, leaders = find_rooms(msp)
    put_labels_in_rooms(msp, leaders)  # small rooms: number inside the room, no leader line
    fills, joins = fill_walls(msp)  # solid walls; also takes the columns out of the drawing

    backend = render(KEEP_LAYERS)  # what the map shows
    page = layout.Page(0, 0, layout.Units.inch, margins=layout.Margins.all(0))
    text = backend.get_string(page, render_box=content)

    # Draw the wall fills under the lines: right after the white page, in the SVG's own units.
    width, height = map(float, re.search(r'viewBox="0 0 (\S+) (\S+)"', text).groups())

    def ring(points):
        return "M" + "L".join(
            f"{(x - content.extmin.x) / content.size.x * width:.0f} {(content.extmax.y - y) / content.size.y * height:.0f}"
            for x, y in points[:-1]  # the last point repeats the first; Z closes the ring instead
        ) + "Z"

    outline = f' stroke="#000000" stroke-width="{0.00014 * width:.0f}" stroke-linejoin="round"' if REDRAW_WALLS else ""  # redrawn walls get their own thin black edge
    def path_of(group, attributes):
        d = "".join(ring(r.coords) for shape in group for r in [shape.exterior, *shape.interiors])
        return f'<path d="{d}" fill-rule="evenodd" {attributes} />' if group else ""

    if REDRAW_WALLS:  # on top of the drawing's lines: white over the removed boxes (joins holds those patches), then the walls
        paths = path_of(joins, 'fill="#ffffff"') + path_of(fills, f'fill="{WALL_FILL}"{outline}')
        text, placed = re.subn(r"</svg>\s*$", lambda m: paths + "</svg>", text, count=1)
    else:  # under the drawing's lines: the walls, then the pieces that join walls across a removed column
        paths = path_of(fills, f'fill="{WALL_FILL}"') + path_of(joins, f'fill="{WALL_FILL}"')
        text, placed = re.subn(r'(<rect fill="#ffffff"[^>]*/>)', lambda m: m.group(1) + paths, text, count=1)
    if not placed:
        print("wall fill NOT added: couldn't find where to put it in the SVG")
    with open(svg_dst, "wt") as f:
        f.write(text)

    if rooms_dst:
        # Store positions as fractions (0–1) of the SVG's width and height,
        # measured from its top-left corner (CAD y points up, SVG y points down).
        def to_fraction(x, y):
            return (
                round((x - content.extmin.x) / content.size.x, 5),
                round((content.extmax.y - y) / content.size.y, 5),
            )

        found, rooms = rooms, []
        for room in found:
            fx, fy = to_fraction(room["x"], room["y"])
            if 0 <= fx <= 1 and 0 <= fy <= 1:
                outline = room.pop("outline")
                if outline:
                    room["outline"] = [list(to_fraction(x, y)) for x, y in outline]  # [[x, y], ...]
                rooms.append({**room, "x": fx, "y": fy})
        rooms.sort(key=lambda r: r["number"])
        with open(rooms_dst, "wt") as f:
            json.dump(rooms, f, indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
