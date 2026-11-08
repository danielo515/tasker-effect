#!/usr/bin/env bash
# (Re)build <assets-dir>/tasker-js.zip from every other file in the directory,
# flat at the zip root (no folder), so the imported TE Sync task can download
# it with Tasker's native HTTP Request action and extract it with UnZip
# straight into the device JS dir. Files never pass through a Tasker string,
# so no %variable expansion can touch them. The per-file assets stay
# alongside the zip (the Node-side sync downloads those).
#
# Run by the CI release job before publishing (so both the snapshot and the
# rolling release carry the zip) and again by update-rolling-release.sh (so a
# rollback to an older snapshot without a zip still gets one).
set -euo pipefail

DIR=${1:?usage: add-release-zip.sh <assets-dir>}
ZIP=tasker-js.zip

# Never zip a previous zip into the new one.
rm -f "$DIR/$ZIP"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
zip -q -j -X "$TMP/$ZIP" "$DIR"/*
mv "$TMP/$ZIP" "$DIR/$ZIP"
