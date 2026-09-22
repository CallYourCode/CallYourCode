#!/bin/sh
#
# site/build.sh -- Cloudflare Pages build command for callyourcode.com.
#
# Pages serves the site/ directory as the root and runs this script as the
# build step. Its only job is to keep site/install.sh a byte-identical copy of
# the single source of truth, scripts/install.sh, so the one-liner
#
#   curl -fsSL https://callyourcode.com/install.sh | sh
#
# always serves exactly what the repo ships. The drift test
# (site/drift.test.ts) fails when the two files diverge, so the committed copy
# is CI-guarded.
#
set -eu

# Resolve the repo root from this script's location so the build works from any
# working directory Pages happens to use.
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH= cd -- "$here/.." && pwd)

cp -- "$root/scripts/install.sh" "$here/install.sh"

echo "site/build.sh: copied scripts/install.sh -> site/install.sh"
