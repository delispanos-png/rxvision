"""Pharmacy reimbursement deductions — Rebate (Ν.3918/2011) + turnover discount (Ν.4052/2012).

Both apply ONLY to ΕΟΠΥΥ **medicines** (φάρμακα) — NOT vaccines (Εθνικό Πρόγραμμα Εμβολιασμών,
distinct submission) and NOT ΦΥΚ (Ν.3816/10, own channel). Both are **progressive / κλιμακωτά**:
each bracket's portion of the monthly net value is charged at that bracket's own rate (confirmed with
the pharmacist). Everything is in INTEGER CENTS, like the rest of the codebase.

The functions return a per-bracket breakdown so the UI can show the exact formula in a KPI tooltip
(the pharmacist wants to be able to verify the number while we are still pre-production).
"""
from __future__ import annotations

# (lower_cents, upper_cents | None=open, rate) — monthly NET value (αιτούμενο/Καθαρή Αξία).
REBATE_BRACKETS: list[tuple[int, int | None, float]] = [
    (0, 500_000, 0.0),            # 0 – 5.000 €    → 0%
    (500_000, 1_000_000, 0.015),  # 5.001 – 10.000 € → 1,5%
    (1_000_000, 2_000_000, 0.03),  # 10.001 – 20.000 € → 3%
    (2_000_000, 3_500_000, 0.05),  # 20.001 – 35.000 € → 5%
    (3_500_000, 5_000_000, 0.07),  # 35.001 – 50.000 € → 7%
    (5_000_000, None, 0.08),       # 50.001 € +     → 8%
]

# Turnover discount — only bites above 35.000 € (handled naturally by the 0% first bracket).
DISCOUNT_BRACKETS: list[tuple[int, int | None, float]] = [
    (0, 3_500_000, 0.0),             # 0 – 35.000 €     → 0%
    (3_500_000, 5_000_000, 0.005),   # 35.001 – 50.000 € → 0,5%
    (5_000_000, 6_000_000, 0.0125),  # 50.001 – 60.000 € → 1,25%
    (6_000_000, 8_000_000, 0.0225),  # 60.001 – 80.000 € → 2,25%
    (8_000_000, 10_000_000, 0.035),  # 80.001 – 100.000 € → 3,5%
    (10_000_000, None, 0.05),        # 100.001 € +     → 5%
]


def _progressive(net_cents: int, brackets: list[tuple[int, int | None, float]]) -> dict:
    """Apply a progressive (κλιμακωτή) scale. Returns total + the per-bracket breakdown."""
    net = max(0, int(net_cents or 0))
    total = 0
    breakdown: list[dict] = []
    for lo, hi, rate in brackets:
        if net <= lo:
            break
        upper = net if hi is None else min(net, hi)
        base = upper - lo
        if base <= 0:
            continue
        amount = round(base * rate)
        total += amount
        if rate > 0:
            breakdown.append({"from": lo, "to": hi, "rate": rate, "base": base, "amount": amount})
    return {"net": net, "total": total, "breakdown": breakdown}


def rebate(net_cents: int) -> dict:
    """Monthly ΕΟΠΥΥ rebate (Ν.3918/2011) on the φάρμακα net value."""
    return _progressive(net_cents, REBATE_BRACKETS)


def turnover_discount(net_cents: int) -> dict:
    """Annual turnover discount (έκπτωση βάσει τζίρου, Ν.4052/2012) on the φάρμακα net value."""
    return _progressive(net_cents, DISCOUNT_BRACKETS)


def deductions(net_cents: int) -> dict:
    """Full picture for an ΕΟΠΥΥ-φάρμακα net value: rebate + discount + net receipt."""
    r = rebate(net_cents)
    d = turnover_discount(net_cents)
    net = max(0, int(net_cents or 0))
    return {
        "base": net,
        "rebate": r["total"], "rebate_breakdown": r["breakdown"],
        "discount": d["total"], "discount_breakdown": d["breakdown"],
        "receipt": net - r["total"] - d["total"],  # what actually lands after the two deductions
    }
