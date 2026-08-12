#!/usr/bin/env python3
"""Archive validated fund holding disclosures for R2."""

from __future__ import annotations

import argparse
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

API_URL = "https://fundmobapi.eastmoney.com/FundMNewApi/FundMNInverstPosition"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024


def parse_codes(value: str) -> List[str]:
    codes = [part.strip() for part in value.split(",") if part.strip()]
    if not codes or any(len(code) != 6 or not code.isdigit() for code in codes):
        raise PipelineError("--codes 必须是逗号分隔的六位基金代码")
    if len(set(codes)) != len(codes):
        raise PipelineError("--codes 含重复基金代码")
    return codes


def _url(code: str) -> str:
    query = urlencode(
        {
            "FCODE": code,
            "deviceid": "lookthru",
            "plat": "Iphone",
            "product": "EFund",
            "version": "6.2.8",
        }
    )
    return f"{API_URL}?{query}"


def normalize_holdings(code: str, raw: object) -> Dict[str, object]:
    if not isinstance(raw, dict) or not isinstance(raw.get("Datas"), dict):
        raise PipelineError(f"{code} 持仓响应缺少 Datas")
    report_date = require_iso_date(raw.get("Expansion"), field=f"{code} 持仓报告期")
    stocks = raw["Datas"].get("fundStocks")
    if not isinstance(stocks, list) or not stocks:
        raise PipelineError(f"{code} 持仓响应没有股票明细")

    holdings: List[Dict[str, object]] = []
    industries: Dict[str, Dict[str, object]] = {}
    seen = set()
    for index, stock in enumerate(stocks):
        if not isinstance(stock, dict):
            raise PipelineError(f"{code} 第 {index + 1} 条持仓不是对象")
        stock_code = stock.get("GPDM")
        stock_name = stock.get("GPJC")
        market = stock.get("NEWTEXCH")
        try:
            weight = float(stock.get("JZBL"))
        except (TypeError, ValueError) as error:
            raise PipelineError(f"{code} 第 {index + 1} 条持仓权重非法") from error
        if (
            not isinstance(stock_code, str)
            or not stock_code
            or not isinstance(stock_name, str)
            or stock_code in seen
            or not math.isfinite(weight)
            or weight <= 0
            or weight > 100
        ):
            raise PipelineError(f"{code} 第 {index + 1} 条持仓代码、名称或权重非法")
        seen.add(stock_code)
        secid = f"{market}.{stock_code}" if market in ("0", "1") else None
        holdings.append(
            {
                "stockCode": stock_code,
                "stockName": stock_name,
                "weight": weight,
                "secid": secid,
            }
        )
        industry_code = stock.get("INDEXCODE")
        industry_name = stock.get("INDEXNAME")
        if isinstance(industry_code, str) and isinstance(industry_name, str):
            current = industries.setdefault(
                industry_code,
                {"code": industry_code, "name": industry_name, "weight": 0.0},
            )
            current["weight"] = float(current["weight"]) + weight

    coverage = sum(float(holding["weight"]) for holding in holdings)
    if not math.isfinite(coverage) or coverage <= 0 or coverage > 100:
        raise PipelineError(f"{code} 持仓覆盖率异常: {coverage}")
    return {
        "generatedAt": utc_now(),
        "fundCode": code,
        "reportDate": report_date,
        "coverageWeight": round(coverage, 4),
        "holdings": holdings,
        "industries": sorted(industries.values(), key=lambda row: -float(row["weight"])),
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--codes", required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--source-file", action="append", default=[], metavar="CODE=PATH")
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

        documents: Dict[str, Dict[str, object]] = {}
        for code in codes:
            raw = (
                decode_json(offline[code].read_bytes(), source=str(offline[code]))
                if offline
                else decode_json(
                    fetch_bytes(
                        _url(code),
                        source=f"东财持仓 {code}",
                        max_bytes=MAX_RESPONSE_BYTES,
                    ),
                    source=f"东财持仓 {code}",
                )
            )
            documents[code] = normalize_holdings(code, raw)

        for code, document in documents.items():
            report_date = str(document["reportDate"])
            payload = json_bytes(document)
            write_atomic(
                args.output_dir / "holdings" / code / f"{report_date}.json",
                payload,
            )
            write_atomic(args.output_dir / "holdings" / code / "latest.json", payload)
        print(f"generated {len(documents)} holdings archives under {args.output_dir / 'holdings'}")
        return 0
    except (PipelineError, OSError) as error:
        print(f"holdings pipeline failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
