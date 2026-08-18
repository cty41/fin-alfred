import types
import unittest
import datetime as dt
from unittest.mock import patch

import pandas as pd

from akshare_adapter import _call_akshare, _price_history, _request_with_retry


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


if __name__ == "__main__":
    unittest.main()
