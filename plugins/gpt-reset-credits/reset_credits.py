#!/usr/bin/env python3
"""Safe, stdlib-only client for the explicit GPT reset-card workflow."""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


BASE_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits"
TIMEOUT_SECONDS = 20
GET_ATTEMPTS = 3
UTC = timezone.utc
SHANGHAI = timezone(timedelta(hours=8), name="UTC+8")


class SafeError(Exception):
    def __init__(self, result: str, message: str, status: int | None = None):
        self.result = result
        self.message = message
        self.status = status
        super().__init__(message)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))


def safe_error(error: SafeError, operation: str) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "result": error.result,
        "operation": operation,
        "message": error.message,
    }
    if error.status is not None:
        payload["http_status"] = error.status
    return payload


def token_from_auth(data: Any) -> str | None:
    if not isinstance(data, dict):
        return None
    codex_token = data.get("tokens", {}).get("access_token")
    if isinstance(codex_token, str) and codex_token:
        return codex_token
    openai_token = data.get("openai", {}).get("access")
    if isinstance(openai_token, str) and openai_token:
        return openai_token
    return None


def load_token() -> str:
    configured = os.environ.get("CODEX_AUTH_PATH")
    if configured:
        candidates = [Path(configured)]
    else:
        data_home = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share"))
        candidates = [
            Path.home() / ".codex" / "auth.json",
            data_home / "opencode" / "auth.json",
        ]

    found_file = False
    for path in candidates:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            continue
        except (OSError, json.JSONDecodeError) as exc:
            raise SafeError("credential_error", "无法读取凭证文件。请重新登录 OpenCode/Codex 或检查 CODEX_AUTH_PATH。") from exc
        found_file = True
        token = token_from_auth(data)
        if token is not None:
            return token

    if found_file:
        raise SafeError("credential_error", "凭证文件中没有可用的 OpenAI access token。请重新登录 OpenCode/Codex。")
    raise SafeError("credential_error", "未找到 OpenCode/Codex 凭证文件。请登录 OpenCode/Codex，或设置 CODEX_AUTH_PATH。")


def request_json(method: str, url: str, token: str, body: dict[str, Any] | None = None, *, retry: bool) -> tuple[int, Any | None]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers.update({
            "Content-Type": "application/json",
            "OAI-Product-Sku": "codex",
            "User-Agent": "codex-cli",
        })
    attempts = GET_ATTEMPTS if retry else 1
    last_network_error: Exception | None = None
    for attempt in range(attempts):
        try:
            request = Request(url, data=data, headers=headers, method=method)
            with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
                status = response.status
                raw = response.read()
        except HTTPError as exc:
            status = exc.code
            raw = exc.read()
        except (URLError, TimeoutError, OSError) as exc:
            last_network_error = exc
            if retry and attempt + 1 < attempts:
                time.sleep(2**attempt)
                continue
            raise SafeError("network_error", "网络请求失败；未展示服务端响应详情。") from exc

        if status == 401:
            raise SafeError("auth_expired", "401 Unauthorized：Codex 凭证已过期或无效，请重新登录 Codex。", status)
        if 500 <= status < 600 and retry and attempt + 1 < attempts:
            time.sleep(2**attempt)
            continue
        if not 200 <= status < 300:
            raise SafeError("http_error", "请求失败；未展示服务端响应详情。", status)
        try:
            return status, json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SafeError("invalid_response", "服务端返回了无法解析的响应。", status) from exc
    raise SafeError("network_error", "网络请求失败；未展示服务端响应详情。") from last_network_error


def parse_time(value: Any) -> datetime:
    if not isinstance(value, str):
        raise ValueError("timestamp missing")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def display_time(value: datetime) -> str:
    return value.astimezone(SHANGHAI).strftime("%Y-%m-%d %H:%M")


def remaining(value: datetime) -> str:
    seconds = (value - datetime.now(UTC)).total_seconds()
    if seconds <= 0:
        return "已过期"
    if seconds >= 86400:
        return f"{int(seconds // 86400)} 天"
    return f"{max(1, int((seconds + 3599) // 3600))} 小时"


def hmac_key(token: str, message: str) -> str:
    digest = hmac.new(token.encode(), message.encode(), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def available_cards(response: Any, token: str) -> tuple[list[dict[str, Any]], str]:
    if not isinstance(response, dict) or not isinstance(response.get("credits"), list):
        raise SafeError("invalid_response", "服务端响应不符合预期的重置卡结构。")
    rows: list[dict[str, Any]] = []
    try:
        for credit in response["credits"]:
            if not isinstance(credit, dict) or credit.get("status") != "available":
                continue
            card_id, title = credit.get("id"), credit.get("title")
            expires = parse_time(credit.get("expires_at"))
            if not isinstance(card_id, str) or not card_id or not isinstance(title, str) or not title:
                raise ValueError("invalid card")
            rows.append({"id": card_id, "title": title, "expires": expires})
    except (TypeError, ValueError) as exc:
        raise SafeError("invalid_response", "服务端响应中有无法验证的重置卡。") from exc

    rows.sort(key=lambda row: (row["expires"], row["title"], row["id"]))
    fingerprint = json.dumps(
        [{"id": row["id"], "title": row["title"], "expires_at": row["expires"].isoformat()} for row in rows],
        ensure_ascii=False,
        separators=(",", ":"),
    )
    snapshot_key = hmac_key(token, f"snapshot:{fingerprint}")
    for index, row in enumerate(rows, start=1):
        row["selection_key"] = hmac_key(token, f"selection:{snapshot_key}:{row['id']}")
        row["display"] = {
            "number": index,
            "title": row["title"],
            "remaining": remaining(row["expires"]),
            "expires_at": display_time(row["expires"]),
        }
    return rows, snapshot_key


def query_cards(token: str) -> tuple[list[dict[str, Any]], str]:
    _, response = request_json("GET", BASE_URL, token, retry=True)
    return available_cards(response, token)


def public_cards(cards: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{**row["display"], "selection_key": row["selection_key"]} for row in cards]


def query() -> None:
    try:
        token = load_token()
        cards, snapshot_key = query_cards(token)
        emit({"result": "query_success", "available_count": len(cards), "snapshot_key": snapshot_key, "cards": public_cards(cards)})
    except SafeError as error:
        emit(safe_error(error, "query"))


def post_requery(token: str) -> tuple[list[dict[str, Any]] | None, str | None, SafeError | None]:
    try:
        cards, snapshot = query_cards(token)
        return cards, snapshot, None
    except SafeError as error:
        return None, None, error


def redeem(selection_key: str, snapshot_key: str) -> None:
    try:
        token = load_token()
        before, fresh_snapshot = query_cards(token)
        if not hmac.compare_digest(snapshot_key, fresh_snapshot):
            emit({"result": "aborted_changed", "message": "重置卡列表已变化，未执行兑换。", "available_count": len(before), "snapshot_key": fresh_snapshot, "cards": public_cards(before)})
            return
        target = next((card for card in before if hmac.compare_digest(selection_key, card["selection_key"])), None)
        if target is None:
            emit({"result": "aborted_changed", "message": "所选重置卡已变化，未执行兑换。", "available_count": len(before), "snapshot_key": fresh_snapshot, "cards": public_cards(before)})
            return
    except SafeError as error:
        emit(safe_error(error, "redeem_precheck"))
        return

    post_code: str | None = None
    windows_reset: int | None = None
    post_summary = "兑换请求未获得可验证响应。"
    try:
        status, response = request_json(
            "POST",
            f"{BASE_URL}/consume",
            token,
            {"redeem_request_id": str(uuid.uuid4()), "credit_id": target["id"]},
            retry=False,
        )
        if isinstance(response, dict) and isinstance(response.get("code"), str):
            post_code = response["code"]
            raw_windows = response.get("windows_reset")
            windows_reset = raw_windows if isinstance(raw_windows, int) and not isinstance(raw_windows, bool) else None
            post_summary = "兑换接口已响应。"
        else:
            post_summary = "兑换接口返回了无法验证的响应。"
    except SafeError as error:
        post_summary = error.message
        status = error.status

    after, _, requery_error = post_requery(token)
    if requery_error is not None:
        emit({"result": "uncertain", "message": "兑换后无法完成回查，兑换状态不确定，未再次兑换。", "post_summary": post_summary, "http_status": status if status is not None else None, "requery_result": requery_error.result})
        return

    assert after is not None
    target_absent = all(card["id"] != target["id"] for card in after)
    count_decreased = len(after) == len(before) - 1
    common = {"before_available_count": len(before), "after_available_count": len(after), "post_code": post_code}
    if post_code == "reset" and target_absent and count_decreased and windows_reset is not None and windows_reset > 0:
        emit({"result": "redeem_success", **common, "windows_reset": windows_reset})
        return
    if post_code == "reset" and target_absent and count_decreased and windows_reset == 0:
        emit({"result": "consumed_no_windows", **common, "windows_reset": 0})
        return
    if post_code in {"nothing_to_reset", "no_credit", "already_redeemed"} and not target_absent and len(after) == len(before):
        meanings = {
            "nothing_to_reset": "当前没有可重置的限流窗口。",
            "no_credit": "所选重置卡不可用或已失效。",
            "already_redeemed": "所选重置卡已被兑换。",
        }
        emit({"result": "not_redeemed", **common, "message": meanings[post_code]})
        return
    emit({"result": "uncertain", **common, "message": "兑换响应与回查结果不一致，兑换状态不确定，未再次兑换。", "post_summary": post_summary})


def main() -> None:
    parser = argparse.ArgumentParser(description="Query or redeem GPT reset credits.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("query")
    redeem_parser = commands.add_parser("redeem")
    redeem_parser.add_argument("--selection-key", required=True)
    redeem_parser.add_argument("--snapshot-key", required=True)
    args = parser.parse_args()
    if args.command == "query":
        query()
    else:
        redeem(args.selection_key, args.snapshot_key)


if __name__ == "__main__":
    main()
