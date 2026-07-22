#!/usr/bin/env python3
"""
HTTP GET for m440.in using curl_cffi (Chrome TLS) + Scrapling session cookies.

Bun/fetch TLS fingerprint differs from Chromium — cf_clearance from Scrapling
fails with native fetch. This script impersonates Chrome for actual requests.

Stdin JSON:
  {"url": "https://m440.in/lasted?p=1", "headers": {"Accept": "...", "Referer": "..."}}

Stdout JSON:
  {"ok": true, "status": 200, "headers": {...}, "bodyBase64": "..."}
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

try:
    from curl_cffi import requests as curl_requests
except ImportError:
    print(
        json.dumps(
            {
                "ok": False,
                "error": "curl_cffi not installed (pip install curl_cffi in venv)",
            }
        )
    )
    sys.exit(1)

from m440_session import CHROME_UA, get_or_refresh


def _fetch(url: str, session: dict, extra_headers: dict[str, str], proxy: str | None = None) -> tuple[int, dict[str, str], bytes]:
    cookie_header = session["cookieHeader"]
    user_agent = session.get("userAgent") or CHROME_UA

    headers = {
        "User-Agent": user_agent,
        "Accept": extra_headers.get("Accept", "*/*"),
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": extra_headers.get("Referer", "https://m440.in/"),
        "Origin": extra_headers.get("Origin", "https://m440.in"),
        "Cookie": cookie_header,
    }

    kwargs: dict[str, Any] = {
        "headers": headers,
        "impersonate": "chrome131",
        "timeout": 45,
        "allow_redirects": True,
    }
    if proxy:
        kwargs["proxies"] = {"https": proxy, "http": proxy}

    resp = curl_requests.get(url, **kwargs)

    out_headers: dict[str, str] = {}
    for k, v in resp.headers.items():
        if k.lower() in ("content-type", "content-length", "set-cookie"):
            out_headers[k] = v

    return resp.status_code, out_headers, resp.content


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as e:
        print(json.dumps({"ok": False, "error": f"invalid stdin json: {e}"}))
        sys.exit(1)

    url = payload.get("url")
    if not url or not isinstance(url, str):
        print(json.dumps({"ok": False, "error": "missing url"}))
        sys.exit(1)

    extra_headers = payload.get("headers") or {}
    if not isinstance(extra_headers, dict):
        extra_headers = {}

    proxy = payload.get("proxy") or None

    try:
        session = get_or_refresh(force=False, proxy=proxy)
        status, headers, body = _fetch(url, session, extra_headers, proxy)

        if status == 403:
            session = get_or_refresh(force=True, proxy=proxy)
            status, headers, body = _fetch(url, session, extra_headers, proxy)

        print(
            json.dumps(
                {
                    "ok": status < 400,
                    "status": status,
                    "headers": headers,
                    "bodyBase64": base64.b64encode(body).decode("ascii"),
                },
                ensure_ascii=False,
            )
        )
        sys.exit(0 if status < 400 else 1)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
