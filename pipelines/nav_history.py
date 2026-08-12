#!/usr/bin/env python3
"""Archive complete official NAV histories as deterministic gzip objects."""

from __future__ import annotations

import argparse
import gzip
import math
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence
from urllib.parse import urlencode

from pipeline_common import (
    PipelineError,
    decode_json,
    fetch_bytes,
    json_bytes,
    require_iso_date,
    utc_now,
    write_atomic,
)

API_URL = "https://api.fund.eastmoney.com/f10/lsjz"
PAGE_SIZE = 100
MAX_PAGE_BYTES = 4 * 1024 * 1024


def parse_codes(value: str) -> List[str]:
    codes = [part.strip() for part in value.split(",") if part.strip()]
    if not codes or any(len(code) != 6 or not code.isdigit() for code in codes):
        raise PipelineError("--codes 必须是逗号分隔的六位基金代码")
    if len(set(codes)) != len(codes):
        raise PipelineError("--codes 含重复基金代码")
    return codes


def _page_url(code: str, page: int) -> str:
    return f"{API_URL}?{urlencode({'fundCode': code, 'pageIndex': page, 'pageSize': PAGE_SIZE})}"


def _rows_from_response(raw: object, code: str) -> tuple[List[object], int]:
    if not isinstance(raw, dict) or not isinstance(raw.get("Data"), dict):
        raise PipelineError(f"{code} 净值响应缺少 Data")
    rows = raw["Data"].get("LSJZList")
    total = raw.get("TotalCount")
    if not isinstance(rows, list) or not isinstance(total, int) or total < 1:
        raise PipelineError(f"{code} 净值响应缺少有效 LSJZList/TotalCount")
    return rows, total


def _download_history(code: str) -> List[object]:
    first = decode_json(
        fetch_bytes(
            _page_url(code, 1),
            source=f"东财净值 {code} page=1",
            max_bytes=MAX_PAGE_BYTES,
            referer="https://fundf10.eastmoney.com/",
        ),
        source=f"东财净值 {code} page=1",
    )
    rows, total = _rows_from_response(first, code)
    page = 2
    while len(rows) < total:
        raw = decode_json(
            fetch_bytes(
                _page_url(code, page),
                source=f"东财净值 {code} page={page}",
                max_bytes=MAX_PAGE_BYTES,
                referer="https://fundf10.eastmoney.com/",
            ),
            source=f"东财净值 {code} page={page}",
        )
        page_rows, page_total = _rows_from_response(raw, code)
        if page_total != total or not page_rows:
            raise PipelineError(f"{code} 净值分页总数变化或提前为空")
        rows.extend(page_rows)
        page += 1
    if len(rows) != total:
        raise PipelineError(f"{code} 净值行数 {len(rows)} 与 TotalCount {total} 不符")
    return rows


def _offline_history(path: Path, code: str) -> List[object]:
    rows, total = _rows_from_response(decode_json(path.read_bytes(), source=str(path)), code)
    if len(rows) != total:
        raise PipelineError(f"{code} 离线净值行数 {len(rows)} 与 TotalCount {total} 不符")
    return rows


def normalize_history(code: str, rows: List[object]) -> List[Dict[str, object]]:
    normalized: List[Dict[str, object]] = []
    seen = set()
    for index, raw in enumerate(rows):
        if not isinstance(raw, dict):
            raise PipelineError(f"{code} 第 {index + 1} 条净值不是对象")
        date = require_iso_date(raw.get("FSRQ"), field=f"{code} 第 {index + 1} 条净值日期")
        unit_text = raw.get("DWJZ")
        if not isinstance(unit_text, str):
            raise PipelineError(f"{code} 第 {index + 1} 条净值缺少日期或单位净值")
        try:
            unit_nav = float(unit_text)
            acc_nav = float(raw["LJJZ"]) if raw.get("LJJZ") not in (None, "") else None
            chg_pct = float(raw["JZZZL"]) if raw.get("JZZZL") not in (None, "") else None
        except (TypeError, ValueError) as error:
            raise PipelineError(f"{code} 第 {index + 1} 条净值数值非法") from error
        numeric_values = [value for value in (unit_nav, acc_nav, chg_pct) if value is not None]
        if not all(math.isfinite(value) for value in numeric_values):
            raise PipelineError(f"{code} 第 {index + 1} 条净值含非有限数值")
        if unit_nav <= 0 or date in seen:
            raise PipelineError(f"{code} 第 {index + 1} 条净值非正或日期重复: {date}")
        seen.add(date)
        normalized.append(
            {"date": date, "unitNav": unit_nav, "accNav": acc_nav, "chgPct": chg_pct}
        )
    normalized.sort(key=lambda row: str(row["date"]))
    if not normalized:
        raise PipelineError(f"{code} 净值历史为空")
    return normalized


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument(
        "--source-file",
        action="append",
        default=[],
        metavar="CODE=PATH",
        help="Use one complete offline API response per code.",
    )
    args = parser.parse_args(argv)
    try:
        codes = parse_codes(args.codes)
        offline: Dict[str, Path] = {}
        for value in args.source_file:
            code, separator, path = value.partition("=")
            if not separator or code in offline:
                raise PipelineError(f"--source-file 必须是唯一的 CODE=PATH，收到 {value!r}")
            offline[code] = Path(path)
        if offline and set(offline) != set(codes):
            raise PipelineError("离线模式必须为每个 --codes 基金各提供一个 --source-file")

        archives: Dict[str, bytes] = {}
        for code in codes:
            rows = _offline_history(offline[code], code) if offline else _download_history(code)
            history = normalize_history(code, rows)
            document = {"generatedAt": utc_now(), "fundCode": code, "navHistory": history}
            archives[code] = gzip.compress(json_bytes(document), mtime=0)

        for code, payload in archives.items():
            write_atomic(args.output_dir / "nav" / f"{code}.json.gz", payload)
        print(f"generated {len(archives)} NAV archives under {args.output_dir / 'nav'}")
        return 0
    except (PipelineError, OSError) as error:
        print(f"NAV history pipeline failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
