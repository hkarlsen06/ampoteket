#!/usr/bin/env python3
"""Focused regression checks for static and explicitly unverified SVG geometry."""

from pathlib import Path
import runpy
from types import SimpleNamespace


check_file = runpy.run_path(str(Path(__file__).with_name("check-clipped-ink.py")))["check_file"]


def check(svg):
    return check_file(SimpleNamespace(read_text=lambda: svg))


safe = '<svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" stroke="black" /></svg>'
clipped = safe.replace('x="3"', 'x="0"')
assert check(safe) == ([], [])
assert check(clipped)[0], "Static clipped ink must still fail"
for viewbox in ('0 0 {width} {height}', '{bounds}'):
    violations, notes = check(safe.replace("0 0 20 20", viewbox) + clipped)
    assert violations, "A dynamic SVG must not stop later static checks"
    assert any("manual ink review required" in note for note in notes)
for viewbox in ("0 0 20", "0 0 nan 20", "0 0 0 20", "bad bounds"):
    assert check(safe.replace("0 0 20 20", viewbox))[0], "Invalid literal viewBoxes must fail"
assert not check('<svg viewBox="0 0 10 10" stroke="none"><circle cx="0" cy="0" r="2" /></svg>')[0]
assert check('<svg viewBox="0 0 10 10" stroke="none"><g stroke="black"><circle cx="0" cy="0" r="2" /></g></svg>')[0], "Explicit child strokes override inherited stroke=none"
violations, notes = check('<svg viewBox="0 0 20 20">{#each ["dynamic"] as x}<rect x={x} y="3" width="5" height="5" stroke="black" />{/each}</svg>')
assert not violations and any("manual review required" in note for note in notes)
print("OK: clipped-ink static failures and dynamic review notes")
