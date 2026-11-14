"""Export the navigation-relevant layers of a floor-plan DXF to SVG, plus a
JSON list of rooms (number, name and position on the SVG).

Usage:
  dwg2dxf -y -o cad-source/SPN-level-1.dxf cad-source/SPN-level-1.dwg
  python3 scripts/cad-to-svg.py cad-source/SPN-level-1.dxf \
      public/maps/spn-level1.svg public/maps/spn-level1-rooms.json
  (same for level 2, with spn-level2.*)
"""
import json
import sys

from ezdxf import bbox, path, recover
from ezdxf.enums import TextEntityAlignment
from ezdxf.addons.drawing import Frontend, RenderContext, config, layout, svg

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

    backend = render(KEEP_LAYERS)  # what the map shows
    page = layout.Page(0, 0, layout.Units.inch, margins=layout.Margins.all(0))
    with open(svg_dst, "wt") as f:
        f.write(backend.get_string(page, render_box=content))

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
