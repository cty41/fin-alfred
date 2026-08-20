import types
import unittest
import datetime as dt
from unittest.mock import patch

import pandas as pd
import requests

from akshare_adapter import (
    _call_akshare,
    _price_history,
    _request_with_retry,
    _statement,
    _statement_report_dates,
    _is_retryable,
    financials,
)


class TransportTests(unittest.TestCase):
    @patch("akshare_adapter.time.sleep")
    def test_retries_disconnect_and_adds_eastmoney_headers(self, sleep):
        calls = []

        def get(url, **kwargs):
            calls.append((url, kwargs))
            if len(calls) < 3:
                raise requests.exceptions.ConnectionError("disconnected")
            return "ok"

        result = _request_with_retry(
            requests, get, "https://push2his.eastmoney.com/example"
        )

        self.assertEqual(result, "ok")
        self.assertEqual(len(calls), 3)
        self.assertEqual(
            calls[-1][0], "https://push2his.eastmoney.com/example"
        )
        self.assertIn("Mozilla/5.0", calls[-1][1]["headers"]["User-Agent"])
        self.assertEqual(
            calls[-1][1]["headers"]["Referer"], "https://quote.eastmoney.com/"
        )
        self.assertEqual(sleep.call_count, 2)

    @patch("akshare_adapter.time.sleep")
    def test_retries_on_http_429_and_5xx(self, sleep):
        calls = []

        def get(url, **kwargs):
            calls.append(url)
            if len(calls) < 3:
                resp = requests.Response()
                resp.status_code = 429 if len(calls) == 1 else 500
                resp._content = b"{}"  # noqa: SLF001
                return resp
            return "ok"

        result = _request_with_retry(requests, get, "https://datacenter.eastmoney.com/x")
        self.assertEqual(result, "ok")
        self.assertEqual(len(calls), 3)
        self.assertEqual(sleep.call_count, 2)

    @patch("akshare_adapter.time.sleep")
    def test_does_not_retry_on_other_4xx(self, sleep):
        calls = []

        def get(url, **kwargs):
            calls.append(url)
            resp = requests.Response()
            resp.status_code = 400
            resp._content = b"{}"  # noqa: SLF001
            return resp

        result = _request_with_retry(requests, get, "https://example.test/x")
        self.assertEqual(result.status_code, 400)
        self.assertEqual(len(calls), 1)
        self.assertEqual(sleep.call_count, 0)

    def test_is_retryable_classifies_status_codes(self):
        self.assertTrue(_is_retryable(_FakeResp(429), requests))
        self.assertTrue(_is_retryable(_FakeResp(503), requests))
        self.assertFalse(_is_retryable(_FakeResp(400), requests))
        self.assertFalse(_is_retryable(_FakeResp(200), requests))

    def test_call_restores_akshare_requests_get(self):
        original_get = lambda _url, **_kwargs: "ok"
        request_module = types.SimpleNamespace(get=original_get)

        # Isolated fake function with its own globals so the test module's
        # top-level `requests` import is never clobbered.
        fake_globals = {"requests": request_module}
        fake_akshare_call = types.FunctionType(
            (lambda: requests.get("https://example.test")).__code__,
            fake_globals,
        )
        self.assertEqual(_call_akshare(fake_akshare_call), "ok")
        self.assertIs(request_module.get, original_get)

    def test_price_history_falls_back_to_akshare_sina(self):
        today = dt.date.today()

        class FakeAkshare:
            @staticmethod
            def stock_hk_hist(**_kwargs):
                raise requests.exceptions.ConnectionError("eastmoney unavailable")

            @staticmethod
            def stock_hk_daily(**_kwargs):
                return pd.DataFrame(
                    [{"date": today, "close": 25.88}]
                )

        history = _price_history(FakeAkshare(), "01810")

        self.assertEqual(history[0]["price"], "25.88")
        self.assertEqual(history[0]["source"], "AKShare / Sina")


class _FakeResp:
    def __init__(self, status_code):
        self.status_code = status_code


class FinancialStatementTests(unittest.TestCase):
    def _fake_ak(self, statements):
        class FakeAkshare:
            pass

        fake = FakeAkshare()

        def fake_datacenter(url, params):
            name = params["reportName"]
            if name == "RPT_CUSTOM_HKSK_APPFN_CASHFLOW_SUMMARY":
                return {"result": {"data": [{"REPORT_LIST": statements, "CURRENCY": "HKD"}]}}
            data = {
                "RPT_HKF10_FN_BALANCE_PC": [
                    {"STD_ITEM_NAME": "现金及等价物", "AMOUNT": 100.0, "REPORT_DATE": "2026-06-30 00:00:00"},
                ],
                "RPT_HKF10_FN_INCOME_PC": [
                    {"STD_ITEM_NAME": "营运收入", "AMOUNT": 4000.0, "REPORT_DATE": "2026-06-30 00:00:00"},
                ],
                "RPT_HKF10_FN_CASHFLOW_PC": [],
            }
            return {"result": {"data": data.get(name, [])}}

        fake._datacenter_json = fake_datacenter  # type: ignore[attr-defined]
        return fake

    def test_financials_builds_three_statement_envelope(self):
        reports = [
            {"REPORT_DATE": "2026-06-30 00:00:00"},
            {"REPORT_DATE": "2025-12-31 00:00:00"},
        ]
        ak = self._fake_ak(reports)

        # Patch the module-level _datacenter_json used by financials.
        import akshare_adapter

        real = akshare_adapter._datacenter_json

        def fake(url, params):
            return ak._datacenter_json(url, params)

        akshare_adapter._datacenter_json = fake
        try:
            out = financials(ak, {"symbol": "00700", "indicator": "报告期"})
        finally:
            akshare_adapter._datacenter_json = real

        self.assertEqual(out["currency"], "HKD")
        self.assertEqual(out["reportDates"], ["2026-06-30", "2025-12-31"])
        self.assertEqual(out["statements"]["balance"][0]["STD_ITEM_NAME"], "现金及等价物")
        self.assertEqual(out["statements"]["income"][0]["AMOUNT"], 4000.0)

    def test_annual_indicator_filters_to_year_end(self):
        reports = [
            {"REPORT_DATE": "2026-06-30 00:00:00"},
            {"REPORT_DATE": "2025-12-31 00:00:00"},
        ]
        ak = self._fake_ak(reports)
        import akshare_adapter

        real = akshare_adapter._datacenter_json

        def fake(url, params):
            return ak._datacenter_json(url, params)

        akshare_adapter._datacenter_json = fake
        try:
            out = financials(ak, {"symbol": "00700", "indicator": "年度"})
        finally:
            akshare_adapter._datacenter_json = real

        self.assertEqual(out["reportDates"], ["2025-12-31"])

    def test_statement_uses_balance_column_set_without_start_date(self):
        import akshare_adapter

        seen = {}

        def capture(url, params):
            seen["columns"] = params["columns"]
            seen["reportName"] = params["reportName"]
            return {"result": {"data": []}}

        real = akshare_adapter._datacenter_json
        akshare_adapter._datacenter_json = capture
        try:
            _statement(object(), "00700", "balance", "RPT_HKF10_FN_BALANCE_PC", ["2026-06-30"])
        finally:
            akshare_adapter._datacenter_json = real

        self.assertNotIn("START_DATE", seen["columns"])
        self.assertIn("STD_REPORT_DATE", seen["columns"])


if __name__ == "__main__":
    unittest.main()
