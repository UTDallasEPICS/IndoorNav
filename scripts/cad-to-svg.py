"""Export the navigation-relevant layers of a floor-plan DXF to SVG, plus a
JSON list of rooms (number, name and position on the SVG).

Usage:
  dwg2dxf -y -o cad-source/SPN-level-1.dxf cad-source/SPN-level-1.dwg
  python3 scripts/cad-to-svg.py cad-source/SPN-level-1.dxf \
      public/maps/spn-level1.svg public/maps/spn-level1-rooms.json
"""
import json
import sys

from ezdxf import bbox, recover
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
    return rooms


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
        rooms = []
        for room in find_rooms(msp):
            fx = (room["x"] - content.extmin.x) / content.size.x
            fy = (content.extmax.y - room["y"]) / content.size.y
            if 0 <= fx <= 1 and 0 <= fy <= 1:
                rooms.append({**room, "x": round(fx, 5), "y": round(fy, 5)})
        rooms.sort(key=lambda r: r["number"])
        with open(rooms_dst, "wt") as f:
            json.dump(rooms, f, indent=1)


if __name__ == "__main__":
    main(*sys.argv[1:4])
