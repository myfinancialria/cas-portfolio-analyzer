import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from cas_analyzer.amfi import parse_navall  # noqa: E402
from cas_analyzer.analyze import analyze, bucket_of, fifo_lots, xirr  # noqa: E402
from cas_analyzer.links import clean_scheme_name  # noqa: E402
from cas_analyzer.model import load_statement  # noqa: E402

NAVALL_8COL = """Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date

Open Ended Schemes(Equity Scheme - Flexi Cap Fund)

PPFAS Mutual Fund

122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;90.6349;03-Sep-2026
"""

NAVALL_6COL = """Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date

Open Ended Schemes(Debt Scheme - Liquid Fund)

HDFC Mutual Fund

119091;INF179KB1HP9;-;HDFC Liquid Fund - Direct Plan - Growth;5571.8484;03-Sep-2026
"""


def test_parse_navall_both_layouts():
    snap8 = parse_navall(NAVALL_8COL)
    rec = snap8["INF879O01027"]
    assert rec["code"] == "122639"
    assert rec["cat"] == "Equity Scheme"
    assert rec["sub"] == "Flexi Cap Fund"
    assert rec["amc"] == "PPFAS Mutual Fund"
    assert rec["nav"] == 90.6349
    assert rec["date"] == "2026-09-03"
    assert "Direct Plan" in rec["name"]

    snap6 = parse_navall(NAVALL_6COL)
    assert snap6["INF179KB1HP9"]["sub"] == "Liquid Fund"


def test_xirr_single_year_ten_percent():
    flows = [(dt.date(2024, 1, 1), -100000.0), (dt.date(2025, 1, 1), 110000.0)]
    r = xirr(flows)
    assert abs(r - 0.10) < 0.001


def test_xirr_needs_both_signs():
    assert xirr([(dt.date(2024, 1, 1), -1.0), (dt.date(2025, 1, 1), -1.0)]) is None


def test_bucket_mapping():
    assert bucket_of({"cat": "Equity Scheme", "sub": "Flexi Cap Fund"}, "X") == "Equity"
    assert bucket_of({"cat": "Debt Scheme", "sub": "Liquid Fund"}, "X") == "Debt"
    assert bucket_of({"cat": "Income", "sub": ""}, "Some Bond Fund") == "Debt"
    assert bucket_of({"cat": "Hybrid Scheme", "sub": "Balanced Advantage"}, "X") == "Hybrid"
    assert bucket_of({"cat": "Other Scheme", "sub": "Index Funds"}, "UTI Nifty 50 Index Fund") == "Index & ETF"
    assert bucket_of({"cat": "Other Scheme", "sub": "FoF Domestic"}, "Kotak Gold Fund") == "Gold & Commodity"
    assert bucket_of({"cat": "Other Scheme", "sub": "Index Funds"}, "ICICI Pru NASDAQ 100 Index Fund") == "International"
    assert bucket_of(None, "Mystery Scheme") == "Other"


def test_fifo_partial_redemption():
    lots, remaining = fifo_lots(
        [
            {"date": "2023-01-01", "amount": 1000.0, "units": 100.0},
            {"date": "2023-06-01", "amount": 1500.0, "units": 100.0},
            {"date": "2024-01-01", "amount": -900.0, "units": -150.0},
        ]
    )
    # 150 sold: all of lot 1 (cost 1000) + 50 of lot 2 (cost 750)
    assert len(lots) == 1
    assert abs(remaining - 750.0) < 1e-6


def test_analyze_end_to_end_with_casparser_shape():
    casparser_doc = {
        "statement_period": {"from": "2023-01-01", "to": "2026-08-31"},
        "folios": [
            {
                "folio": "123/0",
                "amc": "PPFAS Mutual Fund",
                "schemes": [
                    {
                        "scheme": "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
                        "isin": "INF879O01027",
                        "amfi": 122639,
                        "open": 0.0,
                        "close": 100.0,
                        "valuation": {"date": "2026-08-31", "nav": 88.0, "value": 8800.0, "cost": 7000.0},
                        "transactions": [
                            {"date": "2023-02-01", "description": "SIP", "amount": 3500.0, "units": 50.0, "nav": 70.0, "type": "PURCHASE_SIP"},
                            {"date": "2024-02-01", "description": "SIP", "amount": 3500.0, "units": 50.0, "nav": 70.0, "type": "PURCHASE_SIP"},
                        ],
                    },
                    {"scheme": "Closed Fund", "isin": "INF000000000", "open": 10.0, "close": 0.0, "valuation": {}},
                ],
            }
        ],
    }
    statement = load_statement(casparser_doc)
    assert len(statement["holdings"]) == 1  # zero-balance scheme dropped

    amfi = json.loads(json.dumps(parse_navall(NAVALL_8COL)))
    analysis = analyze(statement, amfi)
    row = analysis["rows"][0]
    assert row["bucket"] == "Equity"
    assert row["matched"] is True
    assert abs(row["currentValue"] - 100.0 * 90.6349) < 0.01
    assert abs(row["gain"] - (row["currentValue"] - 7000.0)) < 0.01
    assert row["xirr"] is not None and row["xirr"] > 0
    assert analysis["totals"]["portfolioXirr"] is not None
    assert analysis["tax"] is not None
    assert analysis["tax"]["ltGain"] > 0  # both lots > 1y old vs 2026-09
    assert len(row["links"]) == 5


def test_clean_scheme_name():
    assert clean_scheme_name("Parag Parikh Flexi Cap Fund - Direct Plan - Growth") == "Parag Parikh Flexi Cap Fund"
    assert clean_scheme_name("Axis ELSS- Tax Saver Fund - Direct Plan - Growth Option") == "Axis ELSS- Tax Saver Fund"
    assert "Regular" not in clean_scheme_name("SBI Large Cap Fund - Regular Plan - Growth")
