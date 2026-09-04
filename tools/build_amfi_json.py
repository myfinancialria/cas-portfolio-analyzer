#!/usr/bin/env python3
"""Build docs/data/amfi.json — the ISIN → {category, latest NAV} snapshot the
web app reads from its own origin (amfiindia.com sends no CORS headers, so the
browser cannot fetch NAVAll.txt directly).

Run by .github/workflows/update-nav.yml daily. Stdlib only — no pip install.

Usage: python tools/build_amfi_json.py [output-path]
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "cli"))

from cas_analyzer.amfi import build_snapshot  # noqa: E402


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "data" / "amfi.json"
    snap = build_snapshot()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snap, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"wrote {out} — {snap['meta']['schemes']} schemes, NAVs as of {snap['meta']['nav_as_of']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
