#!/usr/bin/env python3
"""Guard against clipped ink anywhere it can occur: SVG viewports and CSS clipping.

Check 1 (failure): stroked SVG ink touching a viewBox edge. SVG strokes are
centred on the shape edge, so a rect authored at x="0" with a 1px stroke loses
half its outline to the viewport — the leftmost column of the landing-page
shelf diagram once rendered exactly that way. Fill-only shapes (no stroke
anywhere on the element or its ancestors, e.g. the decorative QR modules) may
legitimately sit flush to the edge and are exempt. Every potentially-stroked
rect/circle/ellipse/line must keep its ink bounding box at least MIN_PAD
viewBox units inside the viewBox on all four sides; stroked paths must not
start at the min edge (M/H/V at 0). MIN_PAD covers stroke-width/2 plus small
highlight-halo spread: a shape needing a wider halo or an SVG filter region
needs proportionally more padding by hand.

Check 2 (advisory note): CSS `overflow` that clips. An ancestor with
overflow hidden/scroll/auto/clip cuts outlines, box-shadows and focus rings
of everything inside it — the same bug class as check 1, e.g. a header
button's :focus-visible ring sliced by a clipping header. The script lists
every clipping declaration; each one must either contain no focusable
element or be a named §4.2 interior scroll region. Focus rings need 4px of
clearance (2px offset + 2px outline); paddings that provide it must survive
restyling. The human half of this check lives in the design-system §4.1
verification: tab through every interactive element and watch the rings.

Understood syntax (kept deliberately small):
  - literal attributes: x="12", x={12}
  - {#each [0, 1, 2] as v} loops with x/y/width/height/cx/... given as plain
    arithmetic in the loop variable(s), e.g. x={6 + col * 40}
  - <g transform="translate(tx[, ty])"> offset accumulation (only translate)
Anything else dynamic is reported as an unverifiable note, not a failure.

Usage: python3 scripts/check-clipped-ink.py  (wired as `bun run check:ink`)
"""

import itertools
import pathlib
import re
import sys

MIN_PAD = 3.0

TAG_RE = re.compile(r"<(/?)([a-zA-Z][\w]*)((?:[^<>\"'{}]|\"[^\"]*\"|'[^']*'|\{[^{}]*\})*)>")
EACH_RE = re.compile(r"\{#each\s+(\[[^\]]*\])\s+as\s+(\w+)")
EACH_END_RE = re.compile(r"\{/each\}")
ATTR_RE = re.compile(
    r"(x|y|width|height|cx|cy|r|rx|ry|x1|y1|x2|y2|d|fill|stroke|transform)"
    r"""\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})"""
)
VIEWBOX_RE = re.compile(r'viewBox\s*=\s*"([^"]+)"')
TRANSLATE_RE = re.compile(
    r"translate\(\s*([-\d.]+)(?:\s*[,\s]\s*([-\d.]+))?\s*\)"
)
NUMS_RE = re.compile(r"\[([^\]]*)\]")
EDGE_PATH_RE = re.compile(r"[MHVmhv]0(?![\d.])")

SHAPES = {"rect", "circle", "ellipse", "line", "path", "text"}


def parse_num(token):
    token = token.strip().strip("\"'")
    return float(token)


def resolve(expr, loops, notes, where):
    """Resolve a literal or loop-variable expression to (min, max)."""
    expr = expr.strip()
    try:
        return parse_num(expr), parse_num(expr)
    except ValueError:
        pass
    if not loops:
        notes.append(f"{where}: cannot verify dynamic expression {{{expr}}}")
        return None
    names = sorted(loops)
    combos = itertools.product(*(loops[n] for n in names))
    vals = []
    for combo in combos:
        env = dict(zip(names, combo))
        try:
            vals.append(float(eval(expr, {"__builtins__": {}}, env)))  # noqa: S307
        except Exception:  # noqa: BLE001
            notes.append(f"{where}: cannot evaluate {{{expr}}}")
            return None
    return min(vals), max(vals)


def check_file(path):
    violations, notes = [], []
    text = path.read_text()
    line_offsets = [0] + [m.end() for m in re.finditer(r"\n", text)]

    def line_of(pos):
        import bisect

        return bisect.bisect_right(line_offsets, pos)

    for svg in re.finditer(r"<svg\b([^>]*)>(.*?)</svg>", text, re.S):
        svg_attrs = dict(
            (m.group(1), m.group(2) or m.group(3) or m.group(4) or "")
            for m in ATTR_RE.finditer(svg.group(1))
        )
        vb = VIEWBOX_RE.search(svg.group(1))
        if not vb:
            notes.append(f"{path}:{line_of(svg.start())}: svg without viewBox skipped")
            continue
        nums = [float(n) for n in re.sub(r"[,\s]+", " ", vb.group(1)).strip().split(" ")]
        min_x, min_y, vb_w, vb_h = nums[0], nums[1], nums[2], nums[3]
        max_x, max_y = min_x + vb_w, min_y + vb_h
        body = svg.group(2)
        base = svg.start() + svg.group(0).index(body)

        events = []
        for m in TAG_RE.finditer(body):
            events.append((m.start(), "tag", m))
        for m in EACH_RE.finditer(body):
            events.append((m.start(), "each", m))
        for m in EACH_END_RE.finditer(body):
            events.append((m.start(), "endeach", m))
        events.sort(key=lambda e: e[0])

        g_stack = [(0.0, 0.0, None, None)]  # (dx, dy, stroke, stroke_none)
        loop_stack = []
        svg_stroke = svg_attrs.get("stroke")
        svg_stroke_none = svg_stroke == "none"
        g_stack[0] = (0.0, 0.0, svg_stroke, svg_stroke_none)

        for pos, kind, m in events:
            where = f"{path}:{line_of(base + pos)}"
            if kind == "each":
                try:
                    vals = [float(v) for v in NUMS_RE.search(m.group(1)).group(1).split(",")]
                except ValueError:
                    notes.append(f"{where}: non-numeric each list, shapes inside unverified")
                    vals = []
                loop_stack.append((m.group(2), vals))
            elif kind == "endeach":
                if loop_stack:
                    loop_stack.pop()
            else:
                closing, name, raw_attrs = m.group(1), m.group(2), m.group(3)
                if name == "g" and not closing:
                    am = dict(
                        (a.group(1), a.group(2) or a.group(3) or a.group(4) or "")
                        for a in ATTR_RE.finditer(raw_attrs)
                    )
                    dx, dy, stroke, none = g_stack[-1]
                    t = TRANSLATE_RE.search(am.get("transform", ""))
                    if t:
                        dx += float(t.group(1))
                        dy += float(t.group(2) or 0.0)
                    if am.get("stroke") == "none":
                        none = True
                    elif am.get("stroke"):
                        stroke = am["stroke"]
                    g_stack.append((dx, dy, stroke, none))
                elif name == "g" and closing:
                    if len(g_stack) > 1:
                        g_stack.pop()
                elif name in SHAPES and not closing:
                    attrs = dict(
                        (a.group(1), a.group(2) or a.group(3) or a.group(4) or "")
                        for a in ATTR_RE.finditer(raw_attrs)
                    )
                    dx, dy, stroke, none = g_stack[-1]
                    if attrs.get("stroke") == "none":
                        none = True
                    elif attrs.get("stroke"):
                        stroke = attrs["stroke"]
                    loops = dict(loop_stack)
                    fill_only = (
                        attrs.get("fill", "") not in ("", "none") and not stroke
                    )
                    if name == "text" or fill_only:
                        continue
                    if name == "path":
                        d = attrs.get("d", "")
                        edge = EDGE_PATH_RE.search(re.sub(r"\{[^{}]*\}", "", d))
                        if edge and "0" in d:
                            # Confirm the hit is at the viewBox min edge, not e.g. y=10.
                            violations.append(
                                f"{where}: stroked path touches a viewBox edge ({edge.group(0)}…)"
                            )
                        continue
                    bounds = shape_bounds(name, attrs, loops, notes, where)
                    if bounds is None:
                        continue
                    (x0, y0, x1, y1) = bounds
                    x0, x1 = x0 + dx, x1 + dx
                    y0, y1 = y0 + dy, y1 + dy
                    for edge_name, value, limit, inside in (
                        ("left", x0, min_x, 1),
                        ("right", x1, max_x, -1),
                        ("top", y0, min_y, 1),
                        ("bottom", y1, max_y, -1),
                    ):
                        if (value - limit) * inside < MIN_PAD - 1e-9:
                            violations.append(
                                f"{where}: <{name}> ink {x0:.1f}..{x1:.1f},{y0:.1f}..{y1:.1f} "
                                f"within {MIN_PAD:g}px of the {edge_name} viewBox edge "
                                f"({min_x:g}..{max_x:g},{min_y:g}..{max_y:g})"
                            )
                            break
    return violations, notes


def shape_bounds(name, attrs, loops, notes, where):
    def val(key, default=None):
        if key not in attrs:
            return (default, default) if default is not None else None
        return resolve(attrs[key], loops, notes, where)

    if name == "rect":
        x = val("x", 0.0)
        y = val("y", 0.0)
        w = val("width")
        h = val("height")
        if x is None or y is None or w is None or h is None:
            return None
        return (x[0], y[0], x[1] + w[1], y[1] + h[1])
    if name == "circle":
        cx = val("cx", 0.0)
        cy = val("cy", 0.0)
        r = val("r")
        if cx is None or cy is None or r is None:
            return None
        return (cx[0] - r[1], cy[0] - r[1], cx[1] + r[1], cy[1] + r[1])
    if name == "ellipse":
        cx = val("cx", 0.0)
        cy = val("cy", 0.0)
        rx = val("rx")
        ry = val("ry")
        if cx is None or cy is None or rx is None or ry is None:
            return None
        return (cx[0] - rx[1], cy[0] - ry[1], cx[1] + rx[1], cy[1] + ry[1])
    if name == "line":
        x1 = val("x1", 0.0)
        y1 = val("y1", 0.0)
        x2 = val("x2", 0.0)
        y2 = val("y2", 0.0)
        if None in (x1, y1, x2, y2):
            return None
        return (
            min(x1[0], x2[0]),
            min(y1[0], y2[0]),
            max(x1[1], x2[1]),
            max(y1[1], y2[1]),
        )
    return None


OVERFLOW_RE = re.compile(
    r"([^{}]+)\{([^{}]*?overflow\s*:\s*(hidden|scroll|auto|clip)[^{}]*?)\}",
    re.S,
)


def audit_overflow(path):
    """List CSS overflow-clipping declarations as advisory notes."""
    notes = []
    text = path.read_text()
    chunks = [text] if path.suffix == ".css" else []
    if path.suffix == ".svelte":
        chunks = [m.group(0) for m in re.finditer(r"<style>.*?</style>", text, re.S)]
    for chunk in chunks:
        base = text.index(chunk)
        for m in OVERFLOW_RE.finditer(chunk):
            selector = re.sub(r"\s+", " ", m.group(1)).strip()[-80:]
            line = text.count("\n", 0, base + m.start()) + 1
            notes.append(
                f"{path}:{line}: overflow:{m.group(3)} on `{selector}` — "
                "must contain no focusable element (or be a named §4.2 scroll region)"
            )
    return notes


def main():
    root = pathlib.Path(__file__).resolve().parent.parent
    files = sorted(root.joinpath("src").rglob("*.svelte"))
    all_violations, all_notes = [], []
    for path in files:
        v, n = check_file(path)
        all_violations.extend(v)
        all_notes.extend(n)
    for css in sorted(root.joinpath("src").rglob("*.css")):
        all_notes.extend(audit_overflow(css))
    for path in files:
        all_notes.extend(audit_overflow(path))
    for note in all_notes:
        print(f"note: {note}")
    if all_violations:
        print(f"\n{len(all_violations)} clipped-ink violation(s):")
        for v in all_violations:
            print(f"  {v}")
        print(
            "\nKeep stroked ink at least 3 viewBox units inside every viewBox edge "
            "(strokes are centred on the shape, halos/filters spread further)."
        )
        return 1
    print(f"OK: no clipped SVG ink in {len(files)} Svelte file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
