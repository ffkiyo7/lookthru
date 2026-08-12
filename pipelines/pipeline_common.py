#!/usr/bin/env python3
"""Shared failure-visible primitives for lookthru archive pipelines."""

from __future__ import annotations

import json
import os
import random
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen


class PipelineError(RuntimeError):
    pass


_last_request_started: dict[str, float] = {}


def _wait_for_origin(url: str) -> None:
    origin = f"{urlsplit(url).scheme}://{urlsplit(url).netloc}"
    elapsed = time.monotonic() - _last_request_started.get(origin, 0.0)
    remaining = 1.0 - elapsed
    if remaining > 0:
        time.sleep(remaining + random.uniform(0.0, 0.15))
    _last_request_started[origin] = time.monotonic()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def require_iso_date(value: object, *, field: str) -> str:
    if not isinstance(value, str):
        raise PipelineError(f"{field} 不是 YYYY-MM-DD 字符串")
    try:
        parsed = date.fromisoformat(value)
    except ValueError as error:
        raise PipelineError(f"{field} 不是合法日期: {value}") from error
    if parsed.isoformat() != value:
        raise PipelineError(f"{field} 不是规范 YYYY-MM-DD: {value}")
    return value


def fetch_bytes(
    url: str,
    *,
    source: str,
    max_bytes: int,
    accept: str = "application/json",
    referer: Optional[str] = None,
) -> bytes:
    headers = {
        "User-Agent": "lookthru-archive-pipeline/1.0",
        "Accept": accept,
    }
    if referer is not None:
        headers["Referer"] = referer
    request = Request(url, headers=headers)
    try:
        _wait_for_origin(url)
        with urlopen(request, timeout=30) as response:
            payload = response.read(max_bytes + 1)
            if len(payload) > max_bytes:
                raise PipelineError(f"{source} 响应超过 {max_bytes} bytes")
            if response.status < 200 or response.status >= 300:
                raise PipelineError(f"{source} 返回 HTTP {response.status}")
            return payload
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise PipelineError(f"读取 {source} 失败: {error}") from error


def decode_json(payload: bytes, *, source: str) -> Any:
    try:
        return json.loads(payload.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PipelineError(f"{source} 不是合法 UTF-8 JSON") from error


def json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def write_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except FileNotFoundError:
            pass
        raise
