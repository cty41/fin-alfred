"""Narrow JSON adapter between the Rust gateway and AKShare.

Only two whitelisted actions are accepted. Diagnostics go to stderr and stdout
is always a single JSON document so the gateway can validate it atomically.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import math
import statistics
import sys
import time
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import requests


def _load_akshare():
    with contextlib.redirect_stdout(io.StringIO()):
        import akshare  # type: ignore

    return akshare


def _symbol(value: Any) -> str:
    text = str(value).strip().upper().removesuffix(".HK")
    if not text.isdigit() or not 1 <= len(text) <= 5:
        raise ValueError("Hong Kong symbol must contain one to five digits")
    return text.zfill(5)


def _number(value: Any) -> float | None:
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def _iso_date(value: Any) -> str:
    if hasattr(value, "date"):
        value = value.date()
    return str(value)[:10]


def _build_headers(url: str, extra: dict[str, str] | None = None) -> dict[str, str]:
    """Headers currently required by upstream quote providers."""
    headers = dict(extra or {})
    headers.setdefault("User-Agent", "Mozilla/5.0")
    headers.setdefault("Accept", "application/json, text/plain, */*")
    headers.setdefault("Connection", "close")
    if "eastmoney.com" in url:
        headers.setdefault("Referer", "https://quote.eastmoney.com/")
    elif "baidu.com" in url:
        headers.setdefault("Referer", "https://gushitong.baidu.com/")
    return headers


def _default_retry_backoff(attempt: int) -> float:
    """Exponential backoff with small jitter to avoid thundering herd."""
    base = 0.5 * (2**attempt)
    return base * (0.9 + 0.2 * ((time.time() * 7919 + attempt * 104729) % 1))


def _is_retryable(response_or_error: Any, requests_module: Any) -> bool:
    """Return True for transient failures worth retrying (throttling / network)."""
    if isinstance(response_or_error, Exception):
        exc_types = (
            requests.exceptions.ConnectionError,
            requests.exceptions.Timeout,
            requests.exceptions.ReadTimeout,
            requests.exceptions.ChunkedEncodingError,
        )
        return isinstance(response_or_error, exc_types)
    # retry on HTTP 429 (rate limit) and 5xx; not on other 4xx
    status = getattr(response_or_error, "status_code", None)
    return status == 429 or (isinstance(status, int) and status >= 500)


def _request_with_retry(requests_module: Any, original_get: Any, url: str, *args: Any, **kwargs: Any):
    """Add the headers currently required by upstream quote providers.

    AKShare's public functions intentionally remain the data API.  The adapter
    only hardens their process-local HTTP transport; the monkey patch is always
    restored by ``_call_akshare`` before the subprocess handles another call.
    """

    kwargs["headers"] = _build_headers(url, kwargs.pop("headers", None))
    kwargs.setdefault("timeout", 15)

    for attempt in range(3):
        request_url = url
        parsed = urlsplit(url)
        if attempt > 0 and parsed.hostname and parsed.hostname.endswith(".push2his.eastmoney.com"):
            request_url = urlunsplit(
                (parsed.scheme, "push2his.eastmoney.com", parsed.path, parsed.query, parsed.fragment)
            )
        try:
            response = original_get(request_url, *args, **kwargs)
            if not _is_retryable(response, requests_module):
                return response
            if attempt == 2:
                return response  # exhausted retries; return the last response
        except Exception as error:  # noqa: BLE001 - classify and retry transient errors
            if not _is_retryable(error, requests_module) or attempt == 2:
                raise
        time.sleep(_default_retry_backoff(attempt))
    raise AssertionError("unreachable")


def _call_akshare(function: Any, *args: Any, **kwargs: Any):
    requests_module = getattr(function, "__globals__", {}).get("requests")
    if requests_module is None:
        return function(*args, **kwargs)
    original_get = requests_module.get
    requests_module.get = lambda url, *request_args, **request_kwargs: _request_with_retry(
        requests_module, original_get, url, *request_args, **request_kwargs
    )
    try:
        return function(*args, **kwargs)
    finally:
        requests_module.get = original_get


def _price_history(ak: Any, symbol: str) -> list[dict[str, Any]]:
    cutoff = dt.date.today() - dt.timedelta(days=365 * 5)
    source = "AKShare / Eastmoney"
    try:
        frame = _call_akshare(
            ak.stock_hk_hist,
            symbol=symbol,
            period="daily",
            start_date=cutoff.strftime("%Y%m%d"),
            end_date=dt.date.today().strftime("%Y%m%d"),
            adjust="",
        )
    except Exception as eastmoney_error:
        print(
            f"Eastmoney history unavailable for {symbol}; falling back to Sina: "
            f"{eastmoney_error}",
            file=sys.stderr,
        )
        frame = _call_akshare(ak.stock_hk_daily, symbol=symbol, adjust="")
        if "date" in frame.columns:
            frame = frame[
                frame["date"].map(lambda value: str(value)[:10] >= cutoff.isoformat())
            ]
        source = "AKShare / Sina"
    rows: list[dict[str, Any]] = []
    previous: float | None = None
    for _, row in frame.tail(65).iterrows():
        price = _number(row.get("收盘") if "收盘" in row else row.get("close"))
        if price is None or price <= 0:
            continue
        observed_date = row.get("日期") if "日期" in row else row.get("date")
        rows.append(
            {
                "price": str(price),
                "previousClose": None if previous is None else str(previous),
                "observedAt": f"{_iso_date(observed_date)}T16:00:00+08:00",
                "source": source,
            }
        )
        previous = price
    if not rows:
        raise ValueError(f"AKShare returned no price history for {symbol}")
    return rows


def prices(ak: Any, payload: dict[str, Any]) -> dict[str, Any]:
    result = []
    for raw_symbol in payload.get("symbols", []):
        symbol = _symbol(raw_symbol)
        history = _price_history(ak, symbol)
        latest = dict(history[-1])
        latest.update({"symbol": symbol, "history": history})
        result.append(latest)
    return {"fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "prices": result}


def _valuation_series(ak: Any, symbol: str, indicator: str) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    frame = _call_akshare(
        ak.stock_hk_valuation_baidu, symbol=symbol, indicator=indicator, period="全部"
    )
    points: list[tuple[dt.date, float]] = []
    raw: list[dict[str, Any]] = []
    for _, row in frame.iterrows():
        try:
            date = dt.date.fromisoformat(_iso_date(row.get("date")))
        except ValueError:
            continue
        value = _number(row.get("value"))
        if value is None:
            continue
        raw.append({"date": date.isoformat(), "value": value})
        if value > 0:
            points.append((date, value))
    today = dt.date.today()

    def values_since(days: int) -> list[float]:
        cutoff = today - dt.timedelta(days=days)
        return sorted(value for date, value in points if date >= cutoff)

    three = values_since(3 * 365)
    five = values_since(5 * 365)

    def percentile(values: list[float], ratio: float) -> float | None:
        if not values:
            return None
        return values[round((len(values) - 1) * ratio)]

    current = points[-1][1] if points else None
    stats = {
        "current": None if current is None else str(current),
        "threeYearMedian": None if not three else str(statistics.median(three)),
        "fiveYearMedian": None if not five else str(statistics.median(five)),
        "peerMedian": None,
        "validObservations": len(five),
        "percentile10": None if not five else str(percentile(five, 0.1)),
        "percentile90": None if not five else str(percentile(five, 0.9)),
    }
    return stats, raw


def _peer(ak: Any, symbol: str) -> dict[str, Any]:
    frame = _call_akshare(ak.stock_hk_valuation_comparison_em, symbol=symbol)
    if frame.empty:
        raise ValueError(f"AKShare returned no valuation comparison for {symbol}")
    row = frame.iloc[0]
    return {
        "symbol": symbol,
        "name": str(row.get("简称") or symbol),
        "pe": None if _number(row.get("市盈率-TTM")) is None else str(_number(row.get("市盈率-TTM"))),
        "pcf": None if _number(row.get("市现率-TTM")) is None else str(_number(row.get("市现率-TTM"))),
        "included": True,
        "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
    }


def relative(ak: Any, payload: dict[str, Any]) -> dict[str, Any]:
    symbol = _symbol(payload.get("symbol"))
    pe, pe_raw = _valuation_series(ak, symbol, "市盈率(TTM)")
    pcf, pcf_raw = _valuation_series(ak, symbol, "市现率")
    peers = []
    for item in payload.get("peers", []):
        try:
            peers.append(_peer(ak, _symbol(item)))
        except Exception as error:  # a single unavailable peer must not discard the target history
            print(f"peer {item}: {error}", file=sys.stderr)

    for key, stats in (("pe", pe), ("pcf", pcf)):
        values = sorted(
            float(peer[key])
            for peer in peers
            if peer.get(key) is not None and float(peer[key]) > 0
        )
        if values:
            stats["peerMedian"] = str(statistics.median(values))

    return {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "AKShare / Baidu / Eastmoney",
        "pe": pe,
        "pcf": pcf,
        "peRaw": pe_raw,
        "pcfRaw": pcf_raw,
        "peers": peers,
    }


_STATEMENT_REPORTS = {
    "balance": "RPT_HKF10_FN_BALANCE_PC",
    "income": "RPT_HKF10_FN_INCOME_PC",
    "cashflow": "RPT_HKF10_FN_CASHFLOW_PC",
}

# The three statement reports accept different column sets: the balance sheet
# has no START_DATE, while income and cashflow have START_DATE but no
# STD_REPORT_DATE. Requesting a nonexistent column makes the endpoint return
# result=null, so each report carries its own explicit column list.
_STATEMENT_COLUMNS = {
    "balance": (
        "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,ORG_CODE,REPORT_DATE,DATE_TYPE_CODE,"
        "FISCAL_YEAR,STD_ITEM_CODE,STD_ITEM_NAME,AMOUNT,STD_REPORT_DATE"
    ),
    "income": (
        "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,ORG_CODE,REPORT_DATE,DATE_TYPE_CODE,"
        "FISCAL_YEAR,START_DATE,STD_ITEM_CODE,STD_ITEM_NAME,AMOUNT"
    ),
    "cashflow": (
        "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,ORG_CODE,REPORT_DATE,DATE_TYPE_CODE,"
        "FISCAL_YEAR,START_DATE,STD_ITEM_CODE,STD_ITEM_NAME,AMOUNT"
    ),
}


def _datacenter_json(url: str, params: dict[str, Any]) -> dict[str, Any]:
    """GET the Eastmoney datacenter JSON endpoint with unified retry.

    Deliberately routes through ``_call_akshare`` so that the same throttling
    retry used for AKShare-internal calls also applies to the datacenter
    endpoint (which was previously unretried).
    """
    return _call_akshare(_datacenter_http, url, params)


def _datacenter_http(url: str, params: dict[str, Any]) -> dict[str, Any]:
    response = requests.get(url, params=params, headers=_build_headers(url), timeout=15)
    if response.status_code == 429 or response.status_code >= 500:
        # let _request_with_retry's response classification retry it; but the
        # response object is returned to _call_akshare which treats it as a
        # successful call. Handle here defensively by raising on non-OK.
        response.raise_for_status()
    return response.json()


def _statement_report_dates(ak: Any, symbol: str) -> tuple[list[str], str | None]:
    """Return the report dates and reporting currency exposed for a symbol."""
    url = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
    params = {
        "reportName": "RPT_CUSTOM_HKSK_APPFN_CASHFLOW_SUMMARY",
        "columns": "SECUCODE,SECURITY_CODE,SECURITY_NAME_ABBR,START_DATE,REPORT_DATE,"
        "FISCAL_YEAR,CURRENCY,ACCOUNT_STANDARD,REPORT_TYPE",
        "quoteColumns": "",
        "filter": f'(SECUCODE="{symbol}.HK")',
        "source": "F10",
        "client": "PC",
    }
    data_json = _datacenter_json(url, params)
    rows = data_json.get("result", {}).get("data") or []
    if not rows:
        raise ValueError(f"no financial report list for {symbol}")
    report_list = rows[0].get("REPORT_LIST", [])
    currency = rows[0].get("CURRENCY")
    if currency is None and report_list:
        currency = report_list[0].get("CURRENCY")
    dates = [str(item["REPORT_DATE"]).split(" ")[0] for item in report_list]
    return dates, currency


def _statement(ak: Any, symbol: str, name: str, report: str, report_dates: list[str]) -> list[dict[str, Any]]:
    url = "https://datacenter.eastmoney.com/securities/api/data/v1/get"
    date_filter = "','".join(report_dates)
    params = {
        "reportName": report,
        "columns": _STATEMENT_COLUMNS[name],
        "quoteColumns": "",
        "filter": f'(SECUCODE="{symbol}.HK")(REPORT_DATE in (\'{date_filter}\'))',
        "pageNumber": "1",
        "pageSize": "",
        "sortTypes": "-1,1",
        "sortColumns": "REPORT_DATE,STD_ITEM_CODE",
        "source": "F10",
        "client": "PC",
    }
    data_json = _datacenter_json(url, params)
    result = data_json.get("result")
    if result is None:
        raise ValueError(f"{name} statement unavailable: {data_json.get('message')}")
    return result.get("data") or []


def financials(ak: Any, payload: dict[str, Any]) -> dict[str, Any]:
    symbol = _symbol(payload.get("symbol"))
    indicator = payload.get("indicator", "报告期")
    report_dates, currency = _statement_report_dates(ak, symbol)
    report_dates = sorted(set(report_dates), reverse=True)
    if indicator == "年度":
        report_dates = [d for d in report_dates if d.endswith("-12-31")]
    statements: dict[str, list[dict[str, Any]]] = {}
    for name, report in _STATEMENT_REPORTS.items():
        try:
            statements[name] = _statement(ak, symbol, name, report, report_dates)
        except Exception as error:  # a single unavailable statement must not discard the others
            print(f"statement {name} for {symbol}: {error}", file=sys.stderr)
            statements[name] = []
    return {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "AKShare / Eastmoney (datacenter)",
        "symbol": symbol,
        "indicator": indicator,
        "currency": currency,
        "reportDates": report_dates,
        "statements": statements,
    }


def hk_spot(ak: Any, payload: dict[str, Any]) -> dict[str, Any]:
    """Return the full HK securities list (code -> name/currency).

    Uses AKShare's Sina-sourced ``stock_hk_spot``. The upstream call paginates
    internally (dozens of requests) and prints a tqdm progress bar; wrap it in
    a redirected stdout so the progress output never pollutes the atomic JSON
    result the gateway expects on stdout.
    """
    from tqdm import tqdm  # type: ignore

    # Disable tqdm's default output to stderr/iterable decoration.
    import tqdm.std  # type: ignore

    original_init = tqdm.std.tqdm.__init__

    def silent_init(self, *args: Any, **kwargs: Any):
        kwargs["disable"] = True
        original_init(self, *args, **kwargs)

    tqdm.std.tqdm.__init__ = silent_init  # type: ignore[method-assign]
    try:
        frame = _call_akshare(ak.stock_hk_spot)
    finally:
        tqdm.std.tqdm.__init__ = original_init  # type: ignore[method-assign]

    securities: list[dict[str, Any]] = []
    for _, row in frame.iterrows():
        code = _symbol(row.get("代码"))
        name_zh = str(row.get("中文名称") or "").strip()
        name_en = str(row.get("英文名称") or "").strip()
        securities.append(
            {
                "code": code,
                "nameZh": name_zh,
                "nameEn": name_en,
                "currency": "HKD",
            }
        )
    return {
        "fetchedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "source": "AKShare / Sina",
        "count": len(securities),
        "securities": securities,
    }


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"prices", "relative", "financials", "hk_spot"}:
        print(
            "usage: akshare_adapter.py <prices|relative|financials|hk_spot> <json>",
            file=sys.stderr,
        )
        return 2
    try:
        payload = json.loads(sys.argv[2])
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        ak = _load_akshare()
        handlers = {
            "prices": prices,
            "relative": relative,
            "financials": financials,
            "hk_spot": hk_spot,
        }
        output = handlers[sys.argv[1]](ak, payload)
        print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception as error:
        print(
            f"AKShare adapter failed after retries; cached data was retained: {error}",
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
