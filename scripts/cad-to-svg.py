"""Export the navigation-relevant layers of a floor-plan DXF to SVG.

Usage:
  dwg2dxf -y -o cad-source/SPN-level-1.dxf cad-source/SPN-level-1.dwg
  python3 scripts/cad-to-svg.py cad-source/SPN-level-1.dxf public/maps/spn-level1.svg
"""
import sys

from ezdxf import recover
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


def main(src, dst):
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
    page = layout.Page(0, 0, layout.Units.inch, margins=layout.Margins.all(0))
    with open(dst, "wt") as f:
        f.write(backend.get_string(page))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
