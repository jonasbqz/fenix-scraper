#!/usr/bin/env python3
"""
Solve m440.in Cloudflare (Scrapling) and persist session for m440-fetch.py.

Usage:
  python3 scripts/m440-solve.py [--proxy http://user:pass@ip:port]

Stdout JSON:
  {"ok": true, "cookieHeader": "...", "userAgent": "..."}
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from m440_session import get_or_refresh
except ImportError as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)

try:
    proxy = None
    if len(sys.argv) > 1 and sys.argv[1] == "--proxy" and len(sys.argv) > 2:
        proxy = sys.argv[2]

    result = get_or_refresh(force=True, proxy=proxy)
    print(
        json.dumps(
            {
                "ok": True,
                "cookieHeader": result["cookieHeader"],
                "userAgent": result.get("userAgent"),
            },
            ensure_ascii=False,
        )
    )
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)}))
    sys.exit(1)
