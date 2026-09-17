# Homepage 3D models

The `.blend` sources are stored in Git LFS; run `git lfs pull` before opening or
rebuilding them.

Each model has a generator script that rebuilds the `.blend` and exports the served
files. Run from the repository root with Blender 4.3 or newer (builds without
OpenImageDenoise use more samples for the glass render):

```sh
blender -b --python assets/models/build-p2s.py
blender -b --python assets/models/build-soldering-station.py
```

Rebuilding **overwrites** the `.blend`, `static/models/<name>.glb` and
`static/models/<name>.webp`, so port hand edits back into the generator first. No
downloaded assets or external Python packages are needed; compression needs
`bun install`. Sources use metres, Z up, negative Y forward; glTF export converts
to Y up.

The homepage renders the GLB in `model-viewer`. The WebP is a still render used only
for loading, reduced motion, no JavaScript and load errors. Scroll and pointer
behaviour belongs to [page-home.md](../../docs/page-home.md).

## Compression

Blender writes its raw export to the ignored `assets/models/build/`; each generator
then runs `scripts/compress-model.sh <name>`, which writes the served GLB with
Meshopt geometry, quantized attributes and WebP textures. Run the script alone after
changing its options. It keeps the scene graph intact (no flattening, joining,
instancing or empty-node pruning) because the homepage and proofs look up named
nodes. The homepage gives `model-viewer` an empty inline decoder script so 4.3.1
uses the Meshopt decoder bundled with three.js instead of fetching one from a CDN.

## Bambu Lab P2S

The GLB batches evaluated copies by material (the parts stay separate in Blender)
and carries PBR materials, transmission glass and a baked occlusion atlas for
enclosure shadows. The lead screws use their own material without the atlas, because
tiny thread UV islands otherwise show dark gaps. The screen artwork uses an
800 × 424 grid and unlit materials so lighting does not tint it; its markings are
illustration, not live readings.

This is a photo-based visual reconstruction, not CAD: anchored to the published
392 mm width, with small radii, gaps and hidden parts estimated. The standalone
printer is modelled, without AMS, spool or print.

References (inspected, not redistributed): the
[official EU P2S product page](https://eu.store.bambulab.com/products/p2s) and its
[front](https://store.bblcdn.eu/s8/default/50759f43fac940b8b6b623f726d13a14/1.jpg),
[front/right](https://store.bblcdn.eu/s8/default/c788c7aaa7fd4608a58867154029d5b0/P2S.jpg),
[left](https://store.bblcdn.eu/s8/default/e357a3e8749349608871a890e7bc218b/5.jpg) and
[right](https://store.bblcdn.eu/s8/default/bd909061789f4369a51be17442293519/6.jpg) views;
the [replacement lid](https://eu.store.bambulab.com/products/glass-cover-plate-p2s)
([photo](https://store.bblcdn.eu/s8/default/477a47edbe054324a1ca778b8d333823/FAS069.jpg));
[display](https://store.bblcdn.com/s7/default/eed45f06b7c64d44906fc14dc9fed6b6/1_PC_V2_1011.jpg)
and [toolhead](https://store.bblcdn.com/s7/default/a1ca4bae33ac4a2f85b20de191988fdf/PC.jpg)
close-ups; and the [user manual](https://csm.bblcdn.com/hub/9425242c00344b0e801b6179f9a243aa.pdf),
printed pages 11–15.

## Soldering station

The scene keeps named parts, the animated iron hierarchy and cable shape keys. The
GLB contains a four-second `Soldering` clip (frames 1–121 at 30 fps) that the
homepage scrubs with document scroll: the iron leaves its holder, travels over the
board and lowers its tip onto a pad, and a solder fillet grows.

Named nodes the homepage depends on (keep them when editing):

- `IronTipPivot` — animated parent of the rigid iron parts, origin at the tip.
- `SolderContactTarget` — the landing point.
- `IronPointerPivot` — child used for the independent mouse lean.
- `IronCableSocket` — where the cable meets the handle.
- `Flexible iron lead` — 30 animated shape keys; UV U runs from controller (0) to
  handle (1), and the browser deforms its last span with the mouse lean.
- `Fresh solder fillet` — the final joint animation.

The cable is shape keys, not a physics simulation; the pointer deforms a float copy
of the quantized positions without clamping. Node manipulation uses the pinned
`model-viewer` 4.3.1 scene API, so rerun the proof when upgrading the viewer. The
training board is illustrative, not an electrically valid design.

Provenance: the arrangement comes from the owner's workshop screenshot; the shape
matches the TENMA 21-10115 / ATTEN AT938D family (exact variant unconfirmed; the blue
LCD is inferred). References (inspected, not redistributed):
[TENMA datasheet](https://www.farnell.com/datasheets/2724044.pdf) (146 × 120 × 91 mm),
[TENMA manual](https://www.farnell.com/datasheets/1603556.pdf),
[ATTEN AT938D page](https://www.atten.eu/product/1127953/atten-at938d-60w-digital-lead-free-soldering-station)
with [front/side](https://primary.jwwb.nl/public/g/v/p/temp-ujauobspyfghwwvshari/AT938D.jpg)
and [elevated](https://primary.jwwb.nl/public/g/v/p/temp-ujauobspyfghwwvshari/AT938D2.jpg)
photos, and [owner close-ups](https://community.element14.com/members-area/personalblogs/b/john-wiltrout-s-blog/posts/tenma-21-10115-temperature-controlled-soldering-station).

## Licensing

No third-party mesh was bought or imported. All geometry, screen graphics, board
markings and surface grain are authored in the generators. Reference photos and
manuals are not packed into Blender, projected onto meshes or served. Manufacturer
logos, wordmarks and printed branding are omitted.

## Verification

With the site running on port 5174:

```sh
bun scripts/home-printer-proof.ts     # screenshots in ignored test-results/home-printer/
bun scripts/home-soldering-proof.ts   # screenshots in ignored test-results/home-soldering/
bun run check && bun run check:scripts && bun run build
```

The proofs check the loaded mesh, scroll-driven poses and reverse scrolling, pointer
behaviour, layout stability at 360 and 1280 px, both schemes and locales, and the
static fallbacks.
