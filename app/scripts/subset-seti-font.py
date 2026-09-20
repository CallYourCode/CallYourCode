#!/usr/bin/env python3
"""Build and verify the Seti glyph subset used by the Git and Files panels.

The panels only render the literal icon characters declared in
src/features/media/icons.ts.  Keeping this script beside the checked-in WOFF
makes that contract reproducible without asking the plugin assembler to ship
the whole Seti font.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont


APP = Path(__file__).resolve().parent.parent
ICONS = APP / "src/features/media/icons.ts"
SOURCE = APP / "public/assets/fonts/seti.woff"
OUTPUT = APP / "public/assets/fonts/seti-cyc.woff"
ICON_RE = re.compile(r"icon\('([^']+)'\s*,")


def icon_codepoints() -> set[int]:
    return {ord(char) for char in ICON_RE.findall(ICONS.read_text()) for char in char}


def subset_font(output: Path, codepoints: set[int]) -> None:
    font = TTFont(SOURCE)
    options = subset.Options()
    options.layout_features = ["*"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.name_languages = ["*"]
    options.glyph_names = True
    options.symbol_cmap = True
    options.legacy_cmap = True
    options.notdef_glyph = True
    options.notdef_outline = True
    options.recommended_glyphs = True
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=codepoints)
    subsetter.subset(font)
    font.flavor = "woff"
    font.save(output)


def verify(path: Path, codepoints: set[int]) -> None:
    actual = set(TTFont(path).getBestCmap())
    if actual != codepoints:
        missing = sorted(codepoints - actual)
        extra = sorted(actual - codepoints)
        raise SystemExit(f"{path}: Seti subset mismatch; missing={missing}, extra={extra}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="verify the checked-in subset only")
    args = parser.parse_args()
    codepoints = icon_codepoints()
    if not codepoints:
        raise SystemExit(f"no Seti icons found in {ICONS}")
    if not args.check:
        subset_font(OUTPUT, codepoints)
    verify(OUTPUT, codepoints)
    print(f"seti-cyc.woff: {len(codepoints)} glyphs, {OUTPUT.stat().st_size} bytes")


if __name__ == "__main__":
    main()
