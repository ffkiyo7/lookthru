#!/usr/bin/env python3
"""Generate the A-share trading calendar from SSE annual closure notices."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

SSE_NOTICE_LIST_URL = "https://www.sse.com.cn/disclosure/dealinstruc/closed/list/"
USER_AGENT = "lookthru-trading-calendar/1.0"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
DATE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
NOTICE_TITLE_PATTERN = re.compile(
    r"关于上海证券交易所(?P<year>\d{4})年(?:部分节假日|全年)休市安排的通知"
)
DATE_RANGE_PATTERN = re.compile(
    r"(?:(?P<start_year>\d{4})年)?"
    r"(?P<start_month>\d{1,2})月(?P<start_day>\d{1,2})日"
    r"(?:（[^）]+）)?"
    r"(?:至(?:(?P<end_year>\d{4})年)?"
    r"(?P<end_month>\d{1,2})月(?P<end_day>\d{1,2})日"
    r"(?:（[^）]+）)?)?休市"
)
REQUIRED_HOLIDAYS = ("元旦", "春节", "清明节", "劳动节", "端午节", "国庆节")


class CalendarPipelineError(RuntimeError):
    pass


class _AnnualNoticeLinkParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self._href: Optional[str] = None
        self._text: List[str] = []
        self.links: List[Tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]) -> None:
        if tag != "a" or self._href is not None:
            return
        self._href = dict(attrs).get("href")
        self._text = []

    def handle_data(self, data: str) -> None:
        if self._href is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag != "a" or self._href is None:
            return
        self.links.append(("".join(self._text).strip(), self._href))
        self._href = None
        self._text = []


class _TextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: List[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def _fetch_html(url: str) -> str:
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    try:
        with urlopen(request, timeout=20) as response:
            payload = response.read(MAX_RESPONSE_BYTES + 1)
            if len(payload) > MAX_RESPONSE_BYTES:
                raise CalendarPipelineError(f"上交所响应超过 {MAX_RESPONSE_BYTES} bytes: {url}")
            charset = response.headers.get_content_charset() or "utf-8"
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise CalendarPipelineError(f"读取上交所页面失败: {url}: {error}") from error

    try:
        return payload.decode(charset)
    except UnicodeDecodeError as error:
        raise CalendarPipelineError(f"上交所页面不是合法 {charset}: {url}") from error


def _notice_links(list_html: str, base_url: str) -> Dict[int, str]:
    parser = _AnnualNoticeLinkParser()
    parser.feed(list_html)
    links: Dict[int, str] = {}
    for title, href in parser.links:
        match = NOTICE_TITLE_PATTERN.fullmatch(re.sub(r"\s+", "", title))
        if match is None:
            continue
        year = int(match.group("year"))
        absolute_url = urljoin(base_url, href)
        previous = links.get(year)
        if previous is not None and previous != absolute_url:
            raise CalendarPipelineError(f"上交所 {year} 年年度休市通知出现多个不同链接")
        links[year] = absolute_url
    return links


def _visible_text(html: str) -> str:
    parser = _TextParser()
    parser.feed(html)
    return re.sub(r"\s+", "", "".join(parser.parts))


def _date_from_match(match: re.Match[str], prefix: str, default_year: int) -> date:
    year_text = match.group(f"{prefix}_year")
    year = int(year_text) if year_text is not None else default_year
    try:
        return date(
            year,
            int(match.group(f"{prefix}_month")),
            int(match.group(f"{prefix}_day")),
        )
    except ValueError as error:
        raise CalendarPipelineError(f"上交所公告含非法日期: {match.group(0)}") from error


def _closure_days(notice_html: str, year: int) -> Set[date]:
    text = _visible_text(notice_html)
    title_markers = (
        f"上海证券交易所{year}年部分节假日休市安排",
        f"上海证券交易所{year}年全年休市安排",
    )
    if not any(marker in text for marker in title_markers):
        raise CalendarPipelineError(f"公告标题与目标年份不符: {year}")

    section_start = text.find("一、休市安排")
    section_end = text.find("二、", section_start + 1)
    if section_start < 0 or section_end < 0:
        raise CalendarPipelineError(f"无法定位 {year} 年公告的休市安排正文")
    section = text[section_start:section_end]
    missing_holidays = [holiday for holiday in REQUIRED_HOLIDAYS if holiday not in section]
    if missing_holidays:
        raise CalendarPipelineError(
            f"{year} 年公告缺少预期节假日: {', '.join(missing_holidays)}"
        )

    closures: Set[date] = set()
    ranges = list(DATE_RANGE_PATTERN.finditer(section))
    if len(ranges) < len(REQUIRED_HOLIDAYS):
        raise CalendarPipelineError(
            f"{year} 年公告只解析到 {len(ranges)} 段休市安排，预期至少 {len(REQUIRED_HOLIDAYS)} 段"
        )
    for match in ranges:
        start = _date_from_match(match, "start", year)
        if match.group("end_month") is None:
            end = start
        else:
            end = _date_from_match(match, "end", start.year)
            if match.group("end_year") is None and end < start:
                end = date(start.year + 1, end.month, end.day)
        if end < start or (end - start).days > 30:
            raise CalendarPipelineError(f"{year} 年公告含异常休市区间: {match.group(0)}")
        current = start
        while current <= end:
            closures.add(current)
            current += timedelta(days=1)
    return closures


def _trading_days(year: int, closures: Set[date]) -> List[str]:
    current = date(year, 1, 1)
    end = date(year, 12, 31)
    days: List[str] = []
    while current <= end:
        if current.weekday() < 5 and current not in closures:
            days.append(current.isoformat())
        current += timedelta(days=1)
    return days


def _validate_days(trading_days: Sequence[str], years: Iterable[int]) -> None:
    expected_years = set(years)
    if list(trading_days) != sorted(set(trading_days)):
        raise CalendarPipelineError("tradingDays 必须全局有序且无重复")

    parsed: List[date] = []
    for value in trading_days:
        if not DATE_PATTERN.fullmatch(value):
            raise CalendarPipelineError(f"tradingDays 含非法格式: {value!r}")
        try:
            parsed_day = date.fromisoformat(value)
        except ValueError as error:
            raise CalendarPipelineError(f"tradingDays 含不存在的日期: {value!r}") from error
        if parsed_day.isoformat() != value or parsed_day.weekday() >= 5:
            raise CalendarPipelineError(f"tradingDays 含非交易工作日: {value!r}")
        parsed.append(parsed_day)

    for year in expected_years:
        year_days = [day for day in parsed if day.year == year]
        if not 230 <= len(year_days) <= 255:
            raise CalendarPipelineError(f"{year} 年交易日数量异常: {len(year_days)}")
        if year_days[0].month != 1 or year_days[0].day > 10:
            raise CalendarPipelineError(f"{year} 年首个交易日异常: {year_days[0].isoformat()}")
        if year_days[-1].month != 12 or year_days[-1].day < 20:
            raise CalendarPipelineError(f"{year} 年最后交易日异常: {year_days[-1].isoformat()}")


def build_calendar(notices: Dict[int, str]) -> Dict[str, object]:
    if not notices:
        raise CalendarPipelineError("没有可生成的年度休市公告")
    trading_days: List[str] = []
    for year in sorted(notices):
        closures = _closure_days(notices[year], year)
        trading_days.extend(_trading_days(year, closures))
    _validate_days(trading_days, notices.keys())
    generated_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )
    return {"generatedAt": generated_at, "tradingDays": trading_days}


def _load_notice_files(values: Sequence[str]) -> Dict[int, str]:
    notices: Dict[int, str] = {}
    for value in values:
        try:
            year_text, path_text = value.split("=", 1)
            year = int(year_text)
        except ValueError as error:
            raise CalendarPipelineError(
                f"--notice-file 必须是 YEAR=PATH，收到: {value!r}"
            ) from error
        notices[year] = Path(path_text).read_text(encoding="utf-8")
    return notices


def _download_notices(start_year: int) -> Dict[int, str]:
    list_html = _fetch_html(SSE_NOTICE_LIST_URL)
    links = _notice_links(list_html, SSE_NOTICE_LIST_URL)
    if start_year not in links:
        raise CalendarPipelineError(f"上交所列表页没有 {start_year} 年年度休市通知")
    years = [start_year]
    if start_year + 1 in links:
        years.append(start_year + 1)
    return {year: _fetch_html(links[year]) for year in years}


def _beijing_year() -> int:
    return datetime.now(timezone(timedelta(hours=8))).year


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=_beijing_year())
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--notice-file",
        action="append",
        default=[],
        metavar="YEAR=PATH",
        help="Use local annual notice HTML instead of the network (for deterministic verification).",
    )
    args = parser.parse_args(argv)

    try:
        notices = (
            _load_notice_files(args.notice_file)
            if args.notice_file
            else _download_notices(args.year)
        )
        if args.year not in notices:
            raise CalendarPipelineError(f"输入公告不含目标年份 {args.year}")
        calendar = build_calendar(notices)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps(calendar, ensure_ascii=False, separators=(",", ":")) + "\n",
            encoding="utf-8",
        )
        print(
            f"generated {args.output}: years={','.join(map(str, sorted(notices)))} "
            f"days={len(calendar['tradingDays'])}"
        )
        return 0
    except (CalendarPipelineError, OSError) as error:
        print(f"trading calendar pipeline failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
