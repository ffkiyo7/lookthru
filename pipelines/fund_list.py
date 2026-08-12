#!/usr/bin/env python3
"""Archive the complete public-fund catalogue for R2."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Sequence

from pipeline_common import PipelineError, fetch_bytes, json_bytes, utc_now, write_atomic

FUND_LIST_URL = "https://fund.eastmoney.com/js/fundcode_search.js"
MAX_RESPONSE_BYTES = 5 * 1024 * 1024
MIN_FUND_COUNT = 10_000
CODE_PATTERN = re.compile(r"^\d{6}$")


def parse_fund_list(source: str) -> List[Dict[str, str]]:
    match = re.fullmatch(r"\ufeff?\s*var\s+r\s*=\s*(\[.*\])\s*;?\s*", source, re.DOTALL)
    if match is None:
        raise PipelineError("基金列表不再是 var r = [...] 格式")
    try:
        rows = json.loads(match.group(1))
    except json.JSONDecodeError as error:
        raise PipelineError("基金列表中的 r 不是合法 JSON") from error
    if not isinstance(rows, list):
        raise PipelineError("基金列表 r 不是数组")

    funds: List[Dict[str, str]] = []
    seen = set()
    for index, row in enumerate(rows):
        if not isinstance(row, list) or len(row) < 5 or not all(
            isinstance(value, str) for value in row[:5]
        ):
            raise PipelineError(f"基金列表第 {index + 1} 行格式变化")
        code, pinyin_short, name, fund_type, pinyin_full = row[:5]
        if CODE_PATTERN.fullmatch(code) is None or not name:
            raise PipelineError(f"基金列表第 {index + 1} 行代码或名称非法")
        if code in seen:
            raise PipelineError(f"基金列表代码重复: {code}")
        seen.add(code)
        funds.append(
            {
                "code": code,
                "name": name,
                "type": fund_type,
                "pinyinShort": pinyin_short,
                "pinyinFull": pinyin_full,
            }
        )

    if len(funds) < MIN_FUND_COUNT:
        raise PipelineError(f"基金列表只有 {len(funds)} 只，低于下限 {MIN_FUND_COUNT}")
    return funds


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--source-file", type=Path)
    args = parser.parse_args(argv)
    try:
        payload = (
            args.source_file.read_bytes()
            if args.source_file is not None
            else fetch_bytes(
                FUND_LIST_URL,
                source="东财全量基金列表",
                max_bytes=MAX_RESPONSE_BYTES,
                accept="application/javascript",
                referer="https://fund.eastmoney.com/",
            )
        )
        try:
            source = payload.decode("utf-8-sig")
        except UnicodeDecodeError as error:
            raise PipelineError("基金列表不是合法 UTF-8") from error
        funds = parse_fund_list(source)
        output = {"generatedAt": utc_now(), "funds": funds}
        write_atomic(args.output, json_bytes(output))
        print(f"generated {args.output}: funds={len(funds)}")
        return 0
    except (PipelineError, OSError) as error:
        print(f"fund list pipeline failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
