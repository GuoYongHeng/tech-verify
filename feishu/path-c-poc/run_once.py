#!/usr/bin/env python3
"""Path C feasibility POC: one tick of chats/search → diff → me_join.

Follows 飞书公开群search与me_join自动入群-技术方案.md.
Does NOT use members.create self-pull, empty query, or ProjectMember writes.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

BASE = os.environ.get("FEISHU_BASE_URL", "https://open.feishu.cn/open-apis").rstrip("/")


def env(name: str, default: str | None = None) -> str:
    v = os.environ.get(name, default)
    if v is None or v == "":
        raise SystemExit(f"missing required env: {name}")
    return v


def http_json(
    method: str,
    url: str,
    *,
    token: str | None = None,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json; charset=utf-8"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            reset = resp.headers.get("x-ogw-ratelimit-reset")
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        print(f"HTTP {e.code} {method} {url}\n{raw}", file=sys.stderr)
        if e.code == 429:
            reset = e.headers.get("x-ogw-ratelimit-reset")
            print(f"rate limited; x-ogw-ratelimit-reset={reset}", file=sys.stderr)
        raise SystemExit(1) from e
    try:
        payload = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        print(f"non-JSON response: {raw[:500]}", file=sys.stderr)
        raise SystemExit(1)
    if reset:
        payload["_rate_limit_reset"] = reset
    return payload


def tenant_access_token(app_id: str, app_secret: str) -> str:
    out = http_json(
        "POST",
        f"{BASE}/auth/v3/tenant_access_token/internal",
        body={"app_id": app_id, "app_secret": app_secret},
    )
    token = out.get("tenant_access_token")
    if not token:
        raise SystemExit(f"token failed: {out}")
    return token


def paginate(
    token: str,
    path: str,
    params: dict[str, str],
    items_key: str = "items",
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    page_token = ""
    while True:
        q = dict(params)
        if page_token:
            q["page_token"] = page_token
        url = f"{BASE}{path}?{urllib.parse.urlencode(q)}"
        out = http_json("GET", url, token=token)
        if out.get("code", 0) != 0:
            raise SystemExit(f"API error {path}: {out}")
        data = out.get("data") or {}
        items.extend(data.get(items_key) or [])
        if not data.get("has_more"):
            break
        page_token = data.get("page_token") or ""
        if not page_token:
            break
    return items


def search_chats(token: str, query: str) -> list[dict[str, Any]]:
    if not query or not query.strip():
        raise SystemExit("query must be non-empty (Feishu returns empty list otherwise)")
    if len(query) > 64:
        raise SystemExit("query must be <= 64 chars")
    return paginate(
        token,
        "/im/v1/chats/search",
        {"query": query, "page_size": "100"},
    )


def list_joined(token: str) -> list[dict[str, Any]]:
    return paginate(token, "/im/v1/chats", {"page_size": "100"})


def me_join(token: str, chat_id: str) -> dict[str, Any]:
    # Path C: voluntary join only — never POST .../members (members.create).
    url = f"{BASE}/im/v1/chats/{urllib.parse.quote(chat_id, safe='')}/members/me_join"
    return http_json("PATCH", url, token=token)


def main() -> None:
    parser = argparse.ArgumentParser(description="Path C one-tick POC: search → me_join")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="search + diff only; do not call me_join",
    )
    parser.add_argument(
        "--confirm-public",
        action="store_true",
        help="optional GET /im/v1/chats/:id and skip non-public",
    )
    args = parser.parse_args()

    app_id = env("FEISHU_APP_ID")
    app_secret = env("FEISHU_APP_SECRET")
    query = env("FEISHU_AUTO_JOIN_QUERY")
    allow_re_s = env("FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX")
    max_joins = int(os.environ.get("FEISHU_AUTO_JOIN_MAX_JOINS", "3"))
    deny = {
        x.strip()
        for x in os.environ.get("FEISHU_AUTO_JOIN_CHAT_ID_DENY", "").split(",")
        if x.strip()
    }

    try:
        allow_re = re.compile(allow_re_s)
    except re.error as e:
        raise SystemExit(f"invalid FEISHU_AUTO_JOIN_NAME_ALLOW_REGEX: {e}") from e

    token = tenant_access_token(app_id, app_secret)
    print(f"token ok; query={query!r} allow={allow_re_s!r} max_joins={max_joins}")

    hits = search_chats(token, query)
    joined = list_joined(token)
    joined_ids = {c.get("chat_id") for c in joined if c.get("chat_id")}
    print(f"search_hits={len(hits)} already_joined={len(joined_ids)}")

    candidates: list[dict[str, Any]] = []
    for chat in hits:
        cid = chat.get("chat_id")
        name = chat.get("name") or ""
        if not cid:
            continue
        if cid in joined_ids:
            continue
        if cid in deny:
            print(f"skip deny: {cid} {name!r}")
            continue
        if not allow_re.search(name):
            print(f"skip nameAllowRegex: {cid} {name!r}")
            continue
        candidates.append(chat)

    print(f"diff_after_filter={len(candidates)}")
    for chat in candidates:
        print(f"  candidate: {chat.get('chat_id')} {chat.get('name')!r}")

    if args.dry_run:
        print("dry-run: stop before me_join")
        return

    joined_ok = 0
    for chat in candidates:
        if joined_ok >= max_joins:
            print(f"maxJoinsPerTick={max_joins} reached; stop")
            break
        cid = chat["chat_id"]
        name = chat.get("name") or ""

        if args.confirm_public:
            info = http_json("GET", f"{BASE}/im/v1/chats/{urllib.parse.quote(cid, safe='')}", token=token)
            if info.get("code", 0) != 0:
                print(f"skip get chat: {cid} -> {info}")
                continue
            ctype = (info.get("data") or {}).get("chat_type")
            if ctype != "public":
                print(f"skip non-public chat_type={ctype!r}: {cid} {name!r}")
                continue

        out = me_join(token, cid)
        code = out.get("code", -1)
        if code == 0:
            joined_ok += 1
            print(f"me_join ok: {cid} {name!r}")
        else:
            # common Path C codes: 232075 approval, 232008 type, 232013 full, 232006 bad id
            print(f"me_join fail code={code}: {cid} {name!r} msg={out.get('msg')}")


if __name__ == "__main__":
    main()
