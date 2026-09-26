#!/usr/bin/env python3
"""Build the LED webfont (static/fonts/SevenSegment-led.woff2) from the brand TTF.

    python3 scripts/build-led-font.py

Seven Segment by Krafti Lab (https://www.dafont.com/seven-segment.font) has
proportional digits: '1' is narrow and drawn on the left segments. The Led
component overlays a value on a ghost '8' per digit, so every digit must take the
advance of '8' and sit flush right, like a real seven-segment cell. The subset
keeps only what Led renders: digits, '.', '-', ':' and space.
"""
from fontTools import subset
from fontTools.pens.boundsPen import BoundsPen
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

font.flavor = 'woff2'
font.save(DST)
print(DST)
