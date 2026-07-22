"""Shared m440.in Scrapling session (cookies + UA) for solve/fetch scripts."""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any

SESSION_ENV = "M440_SESSION_FILE"
TTL_ENV = "M440_COOKIE_TTL_MS"
DEFAULT_TTL_S = 20 * 60

CHROME_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


def session_path() -> Path:
    custom = os.environ.get(SESSION_ENV)
    if custom:
        return Path(custom)
    return Path.cwd() / "data" / "m440-scrapling-session.json"


def ttl_seconds() -> int:
    raw = os.environ.get(TTL_ENV)
    if not raw:
        return DEFAULT_TTL_S
    try:
        ms = int(raw)
        return max(60, ms // 1000)
    except ValueError:
        return DEFAULT_TTL_S


def load_session() -> dict[str, Any] | None:
    path = session_path()
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if data.get("expiresAt", 0) <= time.time():
            return None
        if not data.get("cookieHeader"):
            return None
        return data
    except (OSError, json.JSONDecodeError):
        return None


def save_session(data: dict[str, Any]) -> None:
    path = session_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _stealthy_fetch_home(proxy: str | None = None) -> Any:
    """Solve Cloudflare using Patchright directly (Scrapling StealthyFetcher
    may EPIPE on some VPS environments)."""
    try:
        from patchright.sync_api import sync_playwright

        class _Page:
            """Minimal duck-type matching Scrapling page interface."""
            def __init__(self, status: int, cookies: list[dict], user_agent: str):
                self.status = status
                self.cookies = cookies
                self.request_headers = {"User-Agent": user_agent}

        with sync_playwright() as pw:
            launch_args: dict[str, Any] = {"headless": True}
            if proxy:
                launch_args["proxy"] = {"server": proxy}
            browser = pw.chromium.launch(**launch_args)
            ctx = browser.new_context()
            page = ctx.new_page()
            resp = page.goto("https://m440.in/", timeout=90000, wait_until="domcontentloaded")
            status = resp.status if resp else 0

            # Cloudflare challenge page returns 403 initially, then resolves
            # via JS challenge. Wait up to 30s for cf_clearance cookie.
            if status == 403:
                for _ in range(30):
                    page.wait_for_timeout(1000)
                    cookies = ctx.cookies()
                    cf = [c for c in cookies if c["name"] == "cf_clearance"]
                    if cf:
                        break
                else:
                    raise RuntimeError("Cloudflare challenge not solved after 30s")
                status = 200  # Challenge solved, treat as success

            raw_cookies = ctx.cookies()
            user_agent = page.evaluate("navigator.userAgent") or CHROME_UA
            # Convert to dict format expected by solve_and_save
            cookies = [{"name": c["name"], "value": c["value"]} for c in raw_cookies]
            browser.close()

        return _Page(status=status, cookies=cookies, user_agent=user_agent)
    except ImportError:
        # Fallback to Scrapling if patchright not available
        from scrapling.fetchers import StealthyFetcher
        kwargs: dict[str, Any] = {
            "solve_cloudflare": True,
            "headless": True,
            "timeout": 90000,
        }
        if proxy:
            kwargs["proxy"] = proxy
        return StealthyFetcher.fetch("https://m440.in/", **kwargs)


def solve_and_save(proxy: str | None = None) -> dict[str, Any]:
    page = _stealthy_fetch_home(proxy)

    if page.status != 200:
        raise RuntimeError(f"upstream status {page.status}")

    parts: list[str] = []
    for cookie in page.cookies:
        name = cookie.get("name")
        value = cookie.get("value")
        if name and value:
            parts.append(f"{name}={value}")

    if not parts:
        raise RuntimeError("no cookies returned")

    user_agent = CHROME_UA
    try:
        req_headers = getattr(page, "request_headers", None) or {}
        if isinstance(req_headers, dict):
            ua = req_headers.get("User-Agent") or req_headers.get("user-agent")
            if ua:
                user_agent = str(ua)
    except Exception:
        pass

    data = {
        "ok": True,
        "cookieHeader": "; ".join(parts),
        "userAgent": user_agent,
        "expiresAt": time.time() + ttl_seconds(),
    }
    save_session(data)
    return data


def get_or_refresh(force: bool = False, proxy: str | None = None) -> dict[str, Any]:
    manual = os.environ.get("M440_COOKIE_HEADER", "").strip()
    if manual:
        return {
            "ok": True,
            "cookieHeader": manual,
            "userAgent": CHROME_UA,
            "expiresAt": time.time() + ttl_seconds(),
        }

    if not force:
        existing = load_session()
        if existing:
            return existing

    return solve_and_save(proxy)
