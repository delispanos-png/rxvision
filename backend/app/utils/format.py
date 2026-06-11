"""Greek number/currency formatting for backend-built strings (AI insights, notifications, PDFs).

Frontend uses Intl `el-GR`; backend f-strings must match: dot thousands, comma decimals.
Money is stored as integer cents everywhere → divide by 100 here.
"""

from __future__ import annotations


def eur_gr(cents: float | int | None, decimals: int = 0) -> str:
    """Integer cents → Greek-formatted amount: 16100600 → '161.006' (decimals=0) or
    '161.006,00' (decimals=2). Greek convention: '.' thousands, ',' decimal."""
    value = (cents or 0) / 100
    s = f"{value:,.{decimals}f}"                 # US style: '161,006' / '161,006.00'
    return s.replace(",", "\x00").replace(".", ",").replace("\x00", ".")
