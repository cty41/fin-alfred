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


def _request_with_retry(requests_module: Any, original_get: Any, url: str, *args: Any, **kwargs: Any):
    """Add the headers currently required by upstream quote providers.

    AKShare's public functions intentionally remain the data API.  The adapter
    only hardens their process-local HTTP transport; the monkey patch is always
    restored by ``_call_akshare`` before the subprocess handles another call.
    """

    headers = dict(kwargs.pop("headers", {}) or {})
    headers.setdefault(
        "User-Agent",
        "Mozilla/5.0",
    )
    headers.setdefault("Accept", "application/json, text/plain, */*")
    headers.setdefault("Connection", "close")
    if "eastmoney.com" in url:
        headers.setdefault("Referer", "https://quote.eastmoney.com/")
    elif "baidu.com" in url:
        headers.setdefault("Referer", "https://gushitong.baidu.com/")
    kwargs["headers"] = headers
    kwargs.setdefault("timeout", 15)

    for attempt in range(3):
        request_url = url
        parsed = urlsplit(url)
        if attempt > 0 and parsed.hostname and parsed.hostname.endswith(".push2his.eastmoney.com"):
            request_url = urlunsplit(
                (parsed.scheme, "push2his.eastmoney.com", parsed.path, parsed.query, parsed.fragment)
            )
        try:
            return original_get(request_url, *args, **kwargs)
        except (requests_module.exceptions.ConnectionError, requests_module.exceptions.Timeout):
            if attempt == 2:
                raise
            time.sleep(0.35 * (2**attempt))
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


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in {"prices", "relative"}:
        print("usage: akshare_adapter.py <prices|relative> <json>", file=sys.stderr)
        return 2
    try:
        payload = json.loads(sys.argv[2])
        if not isinstance(payload, dict):
            raise ValueError("payload must be an object")
        ak = _load_akshare()
        output = prices(ak, payload) if sys.argv[1] == "prices" else relative(ak, payload)
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
