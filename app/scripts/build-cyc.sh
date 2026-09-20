#!/usr/bin/env bash
# Builds the app into a fresh dist.next, then swaps it into place as dist.
#
# The engine serves app/dist straight from disk, so a page that is already open
# on a phone keeps lazy-importing chunks by their hashed names from the build it
# booted on. A rebuild therefore keeps the previous build's hashed assets: every
# file the previous build produced under assets/ (listed in its built-assets.txt)
# that the new build did not produce is copied into the new assets/ so the open
# page can still load it. Only the immediately previous generation is carried,
# so assets/ holds at most two builds' worth. index.html, build.txt, the service
# worker and everything else non-hashed come only from the new build.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -x node_modules/.bin/vite ]]; then
  echo "build: missing node_modules/.bin/vite" >&2
  exit 1
fi

DIST=dist
NEXT=dist.next
PREV=dist.prev
BUILT_ASSETS=built-assets.txt

rm -rf "$NEXT" "$PREV"
export CYC_BUILD_STAMP="$(date +%s)"
export CYC_DIST_DIR="$NEXT"

node_modules/.bin/vite build --outDir "$NEXT"
node scripts/build-plugins.mjs
printf 'Build stamp: %s\n' "$CYC_BUILD_STAMP" > "$NEXT/build.txt"

# Bake this build's stamp into the copy of cyc-sw.js that ships in dist. vite
# copies public/cyc-sw.js verbatim, where the stamp is the literal placeholder
# __CYC_BUILD__; replacing it makes the served worker's bytes unique per build,
# so a browser's service-worker update check sees the script change, re-installs
# and re-activates (new stamp cache, old caches dropped). Without this the bytes
# never change and the worker freezes on the first build's precache. The stamp is
# the same one in build.txt / cyc-precache.json. Fail loudly if the placeholder
# is missing so a refactor can never silently break the update path.
if ! grep -q '__CYC_BUILD__' "$NEXT/cyc-sw.js"; then
  echo "build: cyc-sw.js is missing the __CYC_BUILD__ stamp placeholder" >&2
  exit 1
fi
sed -i "s/__CYC_BUILD__/$CYC_BUILD_STAMP/" "$NEXT/cyc-sw.js"
echo "build: baked stamp $CYC_BUILD_STAMP into cyc-sw.js"

# Record what this build produced under assets/, so the next build knows which
# files are this generation's own (to carry) and which were themselves carried.
(cd "$NEXT/assets" && find . -type f | sed 's#^\./##' | LC_ALL=C sort) > "$NEXT/$BUILT_ASSETS"

# Precache manifest for the service worker: the app shell (index.html) plus
# every hashed chunk THIS build produced (from built-assets.txt, sorted above),
# minus source maps (never fetched at runtime). The build stamp is the cache
# version, so cyc-sw.js names its cache per build and a rebuild wins cleanly.
# Deterministic and dependency-free; only this build's own assets go in, the
# carried previous-generation ones below stay served but are not precached.
precache_count=0
{
  printf '{"version":"%s","assets":["index.html"' "$CYC_BUILD_STAMP"
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    [[ "$rel" == *.map ]] && continue
    printf ',"assets/%s"' "$rel"
    precache_count=$((precache_count + 1))
  done < "$NEXT/$BUILT_ASSETS"
  printf ']}\n'
} > "$NEXT/cyc-precache.json"
echo "build: wrote cyc-precache.json (index.html + $precache_count asset file(s))"

carried=0
if [[ -d "$DIST/assets" ]]; then
  if [[ -f "$DIST/$BUILT_ASSETS" ]]; then
    previous_assets="$(cat "$DIST/$BUILT_ASSETS")"
  else
    # A dist from before this script recorded its assets: everything in it is
    # one generation, carry it all.
    previous_assets="$(cd "$DIST/assets" && find . -type f | sed 's#^\./##' | LC_ALL=C sort)"
  fi
  while IFS= read -r rel; do
    [[ -n "$rel" ]] || continue
    [[ -f "$DIST/assets/$rel" ]] || continue
    [[ -e "$NEXT/assets/$rel" ]] && continue
    mkdir -p "$NEXT/assets/$(dirname "$rel")"
    cp -p "$DIST/assets/$rel" "$NEXT/assets/$rel"
    carried=$((carried + 1))
  done <<< "$previous_assets"
fi
echo "build: carried $carried asset file(s) from the previous build"

if [[ -d "$DIST" ]]; then
  mv "$DIST" "$PREV"
fi
mv "$NEXT" "$DIST"
rm -rf "$PREV"
echo "build: $DIST ready (stamp $CYC_BUILD_STAMP)"
