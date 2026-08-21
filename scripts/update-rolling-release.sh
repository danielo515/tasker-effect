#!/usr/bin/env bash
# Point the rolling release's assets at the contents of a directory.
#
# Used by CI on every master push (with a fresh dist-tasker/) and by the
# rollback workflow (with the assets of a versioned snapshot). Requires the
# gh CLI authenticated via GH_TOKEN and contents:write on the repo.
set -euo pipefail

TAG=tasker-js-latest
DIR=${1:?usage: update-rolling-release.sh <assets-dir>}

if ! gh release view "$TAG" > /dev/null 2>&1; then
  gh release create "$TAG" \
    --latest \
    --title "Latest compiled Tasker JS" \
    --notes "Rolling release updated by CI on every push. Devices sync from these assets."
fi

# `upload --clobber` overwrites same-named assets but never deletes ones the
# build stopped producing, so prune those first or they linger forever.
gh release view "$TAG" --json assets --jq '.assets[].name' |
  while IFS= read -r asset; do
    if [ ! -e "$DIR/$asset" ]; then
      gh release delete-asset "$TAG" "$asset" --yes
    fi
  done

gh release upload "$TAG" "$DIR"/* --clobber

# Devices resolve /releases/latest (src/sync/core.ts); keep the pointer here
# so versioned snapshots never shadow the rolling release.
gh release edit "$TAG" --latest
