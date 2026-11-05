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
    "A-ROOM NAME",
    "A-ROOM NUMBER",
}

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
    """Pairs each room-number label with the room-name label(s) above it."""
    rooms = [
        {"number": text_of(e), "names": [], "x": x, "y": y}
        for e in msp.query('TEXT MTEXT[layer=="A-ROOM NUMBER"]')
        for x, y in [center_of(e)]
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

    add_outlines(msp, rooms)
    return rooms


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

    backend = svg.SVGBackend()
    cfg = config.Configuration(
        background_policy=config.BackgroundPolicy.WHITE,
        color_policy=config.ColorPolicy.BLACK,
        lineweight_policy=config.LineweightPolicy.RELATIVE,
    )
    Frontend(RenderContext(doc), backend, config=cfg).draw_layout(
        msp, filter_func=lambda e: e.dxf.layer in KEEP_LAYERS
    )

    # Page size 0 = fit to the drawing's extents.
    content = backend.player().bbox()
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

        rooms = []
        for room in find_rooms(msp):
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
