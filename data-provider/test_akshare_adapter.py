import types
import unittest
import datetime as dt
from unittest.mock import patch

import pandas as pd

from akshare_adapter import (
    _call_akshare,
    _price_history,
    _request_with_retry,
    _statement,
    _statement_report_dates,
    financials,
)


class FakeConnectionError(Exception):
    pass


class FakeTimeout(Exception):
    pass


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.requests = types.SimpleNamespace(
            exceptions=types.SimpleNamespace(
                ConnectionError=FakeConnectionError,
                Timeout=FakeTimeout,
            )
        )

    @patch("akshare_adapter.time.sleep")
    def test_retries_disconnect_and_adds_eastmoney_headers(self, sleep):
        calls = []

        def get(url, **kwargs):
            calls.append((url, kwargs))
            if len(calls) < 3:
                raise FakeConnectionError("disconnected")
            return "ok"

        result = _request_with_retry(
            self.requests, get, "https://push2his.eastmoney.com/example"
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

    def test_call_restores_akshare_requests_get(self):
        original_get = lambda _url, **_kwargs: "ok"
        request_module = types.SimpleNamespace(get=original_get)

        def fake_akshare_call():
            return requests.get("https://example.test")

        fake_akshare_call.__globals__["requests"] = request_module
        try:
            self.assertEqual(_call_akshare(fake_akshare_call), "ok")
            self.assertIs(request_module.get, original_get)
        finally:
            fake_akshare_call.__globals__.pop("requests", None)

    def test_price_history_falls_back_to_akshare_sina(self):
        today = dt.date.today()

        class FakeAkshare:
            @staticmethod
            def stock_hk_hist(**_kwargs):
                raise FakeConnectionError("eastmoney unavailable")

            @staticmethod
            def stock_hk_daily(**_kwargs):
                return pd.DataFrame(
                    [{"date": today, "close": 25.88}]
                )

        history = _price_history(FakeAkshare(), "01810")

        self.assertEqual(history[0]["price"], "25.88")
        self.assertEqual(history[0]["source"], "AKShare / Sina")


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
