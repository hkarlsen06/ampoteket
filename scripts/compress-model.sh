#!/bin/sh
# Compress a Blender export (assets/models/build/<name>.glb, ignored) into the
# served static/models/<name>.glb. Meshopt geometry and WebP textures cut the
# download about sixfold. Keep the scene graph as exported: the homepage and its
# proofs look up named nodes, including empty markers that pruning leaves would drop.
set -eu
build="assets/models/build/$1"
bunx gltf-transform prune "$build.glb" "$build.pruned.glb" --keep-leaves true
exec bunx gltf-transform optimize "$build.pruned.glb" "static/models/$1.glb" \
	--compress meshopt --texture-compress webp --simplify false \
	--flatten false --join false --instance false --palette false --prune false
