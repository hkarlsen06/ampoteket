#!/usr/bin/env python3
"""Convert live 'Seven Segment' text in a designer SVG to paths.

The Inkscape files in assets/brand/ set their letters as text in the designer's
"Seven Segment" font by Krafti Lab (https://www.dafont.com/seven-segment.font),
committed as assets/brand/SevenSegment.ttf. Served SVGs carry outlines instead,
so they render without the font.

    python3 scripts/outline-brand-text.py assets/brand/SevenSegment.ttf IN.svg OUT.svg

Each <text> whose style names the font becomes a <path> with the same id,
transform and paint. Everything else is copied byte for byte. Handles what the
designer files use: one or more <tspan>s with x/y, font-size in px, no
letter-spacing or text-anchor (the script fails loudly if it meets either).
The font has no kerning table, so glyph advances alone position the text.
"""
import re
import sys

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

FONT_PROPS = re.compile(r'(font-[a-z-]+|-inkscape-font-specification|line-height|writing-mode|direction):[^;]*;?')


def attr(tag: str, name: str) -> str | None:
    m = re.search(rf'\s{name}="([^"]*)"', tag)
    return m.group(1) if m else None


def style_map(style: str | None) -> dict[str, str]:
    return dict(p.split(':', 1) for p in (style or '').split(';') if ':' in p)


def outline(font: TTFont, text_el: str) -> str:
    head = re.match(r'<text[^>]*>', text_el, re.S).group(0)
    base = style_map(attr(head, 'style'))
    for bad in ('letter-spacing', 'word-spacing', 'text-anchor'):
        if base.get(bad, 'normal') not in ('normal', 'start', '0', '0px'):
            sys.exit(f'unsupported {bad} in {attr(head, "id")}')
    glyphs, cmap, upm = font.getGlyphSet(), font.getBestCmap(), font['head'].unitsPerEm
    pen = SVGPathPen(glyphs, ntos=lambda v: f'{v:.3f}'.rstrip('0').rstrip('.'))
    paint = dict(base)
    spans = re.findall(r'(<tspan[^>]*>)([^<]*)</tspan>', text_el, re.S) or [(head, re.sub(r'<[^>]+>', '', text_el))]
    for tag, chars in spans:
        paint.update(style_map(attr(tag, 'style')))
        size = float(paint['font-size'].removesuffix('px')) / upm
        x = float(attr(tag, 'x') or attr(head, 'x') or 0)
        y = float(attr(tag, 'y') or attr(head, 'y') or 0)
        for ch in chars:
            name = cmap[ord(ch)]
            glyphs[name].draw(TransformPen(pen, (size, 0, 0, -size, x, y)))
            x += glyphs[name].width * size
    d = pen.getCommands()
    if not d:
        return ''
    style = FONT_PROPS.sub('', ';'.join(f'{k}:{v}' for k, v in paint.items()))
    keep = ''.join(f' {k}="{v}"' for k in ('id', 'transform', 'inkscape:label') if (v := attr(head, k)) is not None)
    return f'<path{keep} style="{style}" d="{d}" />'


def main() -> None:
    font_path, src, dst = sys.argv[1:4]
    font = TTFont(font_path)
    svg = open(src, encoding='utf-8').read()
    is_seven = lambda m: 'Seven Segment' in m.group(0)
    svg = re.sub(r'<text\b.*?</text>', lambda m: outline(font, m.group(0)) if is_seven(m) else m.group(0), svg, flags=re.S)
    open(dst, 'w', encoding='utf-8').write(svg)


if __name__ == '__main__':
    main()
