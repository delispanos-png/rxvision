"""Κοινές ρυθμίσεις τεστ.

mongomock (η ψεύτικη MongoDB των τεστ) δεν υποστηρίζει το `$round`, που η παραγωγή χρησιμοποιεί στην
ενημέρωση προϊόντος (engine.py, margin_pct). Χωρίς αυτό ΚΑΘΕ τεστ ingestion αποτύγχανε με
«Unrecognized expression '$round'» και τα τεστ έμεναν μόνιμα κόκκινα — δηλαδή δεν προστάτευαν τίποτα.
Το προσθέτουμε εδώ με τη σημασιολογία της MongoDB ({$round: [αριθμός, δεκαδικά]}).
"""

from __future__ import annotations

try:
    import mongomock.aggregate as _agg
except ImportError:          # τεστ χωρίς mongomock
    _agg = None

if _agg is not None and "$round" not in _agg.arithmetic_operators:
    _orig = _agg._Parser._handle_arithmetic_operator

    def _with_round(self, operator, values):
        if operator == "$round":
            args = values if isinstance(values, (list, tuple)) else [values]
            number = self.parse(args[0])
            places = self.parse(args[1]) if len(args) > 1 else 0
            return None if number is None else round(number, int(places or 0))
        return _orig(self, operator, values)

    _agg._Parser._handle_arithmetic_operator = _with_round
    _agg.arithmetic_operators = _agg.arithmetic_operators | {"$round"}
