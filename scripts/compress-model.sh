#!/bin/sh
# Compress a Blender export (assets/models/build/<name>.glb, ignored) into the
# served static/models/<name>.glb.gz. Meshopt geometry and WebP textures cut the
# download about sixfold. Keep the scene graph as exported: the homepage and its
# proofs look up named nodes, including empty markers that pruning leaves would drop.
# Textures stop at 1024 px: the viewer is at most 28rem wide, and a 2048² map costs
# phones 22 MB of GPU memory. Cloudflare does not compress model/gltf-binary, so the
# file ships gzipped (Meshopt output is built for it) and the homepage unpacks it.
set -eu
build="assets/models/build/$1"
bunx gltf-transform prune "$build.glb" "$build.pruned.glb" --keep-leaves true
bunx gltf-transform optimize "$build.pruned.glb" "$build.optimized.glb" \
	--compress meshopt --texture-compress webp --texture-size 1024 --simplify false \
	--flatten false --join false --instance false --palette false --prune false
gzip -9 -n -c "$build.optimized.glb" > "static/models/$1.glb.gz"
