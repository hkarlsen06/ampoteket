#!/usr/bin/env python3
"""Build the LED webfont (static/fonts/SevenSegment-led.woff2) from the brand TTF.

    python3 scripts/build-led-font.py

Seven Segment by Krafti Lab (https://www.dafont.com/seven-segment.font) has
proportional digits: '1' is narrow and drawn on the left segments. The Led
component overlays a value on a ghost '8' per digit, so every digit must take the
advance of '8' and sit flush right, like a real seven-segment cell. The subset
keeps only what Led renders: digits, '.', '-', ':' and space. The source colon is
two segment-thin dots near the baseline; it is redrawn as larger dots centred in
the digit's upper and lower bays, as on a real clock.
"""
from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont

SRC = 'assets/brand/SevenSegment.ttf'
DST = 'static/fonts/SevenSegment-led.woff2'

font = TTFont(SRC)
opts = subset.Options(flavor='woff2', layout_features=[], name_IDs=['*'], notdef_outline=True)
sub = subset.Subsetter(opts)
sub.populate(text='0123456789.-: ')
sub.subset(font)

glyf, hmtx, glyphs = font['glyf'], font['hmtx'], font.getGlyphSet()


def right_edge(name: str) -> float:
    pen = BoundsPen(glyphs)
    glyphs[name].draw(pen)
    return pen.bounds[2]


advance, edge = hmtx['eight'][0], right_edge('eight')
for name in ('zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'nine'):
    shift = round(edge - right_edge(name))
    glyph = glyf[name]
    glyph.coordinates.translate((shift, 0))
    glyph.recalcBounds(glyf)
    hmtx[name] = (advance, glyph.xMin)

# Dot size and centres in font units; the bays lie between the bottom, middle and
# top segments of '8' (y 131–652 and 782–1304).
dot, chamfer, side = 200, 50, hmtx['colon'][1]
pen = TTGlyphPen(None)
for cy in (391, 1043):
    x0, y0, x1, y1 = side, cy - dot // 2, side + dot, cy + dot // 2
    pen.moveTo((x0, y0 + chamfer))
    for point in ((x0, y1 - chamfer), (x0 + chamfer, y1), (x1 - chamfer, y1), (x1, y1 - chamfer),
                  (x1, y0 + chamfer), (x1 - chamfer, y0), (x0 + chamfer, y0)):
        pen.lineTo(point)
    pen.closePath()
glyf['colon'] = pen.glyph()
hmtx['colon'] = (2 * side + dot, side)

font.flavor = 'woff2'
font.save(DST)
print(DST)
