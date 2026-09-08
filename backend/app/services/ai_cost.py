"""AI cost tracking + cost-plus pricing.

Every real Anthropic call reports token usage. We value it with per-model prices (editable by the
platform admin, defaults = public Anthropic list prices) and accumulate the real cost per tenant/day
in the existing `llm_daily_usage` meter (fields `tok_in`, `tok_out`, `cost_micro`). From the measured
cost we derive a **cost-plus** customer price = real cost/question × (1 + margin%). This lets pricing
follow what we actually pay Anthropic instead of a guessed flat rate.

Money note: prices are in **€cents per 1,000,000 tokens**; cost is stored in **micro-cents**
(cents ×1e6) to keep it integer — `cost_micro = Σ tokens_i × price_per_M_i`, and cents = cost_micro/1e6.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.core.db import shared_db

# Default per-model prices (€cents per 1M tokens): in=input, out=output, cin=cached-input read.
# Public Anthropic list prices at time of writing — EDITABLE in platform_settings._id="ai_pricing".
DEFAULT_MODEL_PRICES: dict[str, dict[str, int]] = {
    "claude-opus-4-8":   {"in": 1500, "out": 7500, "cin": 150},
    "claude-sonnet-4-6": {"in": 300,  "out": 1500, "cin": 30},
    "claude-haiku-4-5":  {"in": 100,  "out": 500,  "cin": 10},
}
DEFAULT_MARGIN_PCT = 40   # μικρό κέρδος πάνω στο πραγματικό κόστος


def _day() -> str:
    return datetime.now(tz=timezone.utc).strftime("%Y-%m-%d")


async def config(db=None) -> dict:
    """Merged pricing config: default model prices + admin overrides + margin%."""
    db = db if db is not None else shared_db()
    doc = await db["platform_settings"].find_one({"_id": "ai_pricing"}) or {}
    models = {m: dict(p) for m, p in DEFAULT_MODEL_PRICES.items()}
    for m, p in (doc.get("models") or {}).items():
        if m in models and isinstance(p, dict):
            for k in ("in", "out", "cin"):
                if p.get(k) is not None:
                    try:
                        models[m][k] = max(0, int(p[k]))
                    except (TypeError, ValueError):
                        pass
    margin = doc.get("margin_pct")
    try:
        margin = max(0, int(margin))
    except (TypeError, ValueError):
        margin = DEFAULT_MARGIN_PCT
    return {"margin_pct": margin, "models": models}


def _usage_tokens(usage) -> tuple[int, int, int, int]:
    """(input, output, cached_read, cache_write) from an Anthropic usage object — 0 if absent."""
    def g(name):
        try:
            return int(getattr(usage, name, 0) or 0)
        except (TypeError, ValueError):
            return 0
    return g("input_tokens"), g("output_tokens"), g("cache_read_input_tokens"), g("cache_creation_input_tokens")


def cost_micro(prices: dict, in_tok: int, out_tok: int, cin_tok: int = 0, cwrite_tok: int = 0) -> int:
    """Micro-cents for one call. input_tokens excludes cached reads; cache writes bill ~like input."""
    # ΠΡΟΣΟΧΗ στην τιμολόγηση Anthropic: η ΕΓΓΡΑΦΗ στην cache κοστίζει 1.25× την τιμή input, ενώ η
    # ΑΝΑΓΝΩΣΗ από cache κοστίζει ~0.1× ("cin"). Πριν χρεώναμε την εγγραφή 1.0× → υποεκτίμηση κόστους.
    return int(in_tok * prices.get("in", 0)
               + cwrite_tok * prices.get("in", 0) * 1.25
               + out_tok * prices.get("out", 0)
               + cin_tok * prices.get("cin", prices.get("in", 0)))


async def record(tenant_id: str | None, model: str, usage, *, db=None) -> None:
    """Value one AI call's usage and add it to today's per-tenant meter. Never raises."""
    if not tenant_id or usage is None:
        return
    try:
        db = db if db is not None else shared_db()
        prices = (await config(db))["models"].get(model) or DEFAULT_MODEL_PRICES.get(model)
        if not prices:
            return
        in_tok, out_tok, cin_tok, cwrite = _usage_tokens(usage)
        micro = cost_micro(prices, in_tok, out_tok, cin_tok, cwrite)
        await db["llm_daily_usage"].update_one(
            {"_id": f"ai:{tenant_id}:{_day()}"},
            {"$inc": {"tok_in": in_tok + cwrite + cin_tok, "tok_out": out_tok, "cost_micro": micro,
                      "n_priced": 1},   # πόσες κλήσεις τιμολογήθηκαν (για ΤΙΜΙΟ μέσο όρο κόστους)
             # ΚΡΙΣΙΜΟ: χρονοσήμανση — το measured() φιλτράρει με `at`. Χωρίς αυτό, όταν το record()
             # δημιουργεί πρώτο το έγγραφο (π.χ. εσωτερικές εργασίες), το κόστος έμενε ΑΟΡΑΤΟ.
             "$setOnInsert": {"at": datetime.now(tz=timezone.utc)}},
            upsert=True)
        await _settle_prepaid(db, tenant_id, micro)
    except Exception:  # noqa: BLE001 — cost metering must never break an AI answer
        pass


async def _settle_prepaid(db, tenant_id: str, micro: int) -> None:
    """Χρέωσε στο προπληρωμένο πορτοφόλι ΜΟΝΟ το μέρος του κόστους που ξεπερνά τον δωρεάν
    προϋπολογισμό της περιόδου — με το ΑΛΗΘΙΝΟ κόστος, όχι με εκτίμηση «1 ερώτηση = 1 credit».

    Ακρίβεια: το κόστος είναι σε micro-λεπτά ενώ το πορτοφόλι σε ακέραια λεπτά· κρατάμε το υπόλοιπο
    (`credit_debt_micro`) στον μετρητή της ημέρας και αφαιρούμε ολόκληρα λεπτά όταν συμπληρώνονται —
    ώστε να μη χάνονται ούτε να διπλοχρεώνονται κλάσματα.
    """
    if micro <= 0 or not tenant_id or str(tenant_id).startswith("__"):
        return
    from app.services import ai_quota, ai_credits
    budget_cents, period = await ai_quota.included_budget(db, tenant_id)
    spent_after = await ai_quota.spent_cents_in_period(db, tenant_id, period)      # σε λεπτά
    prev = spent_after - micro / 1_000_000
    excess_micro = (max(0.0, spent_after - budget_cents) - max(0.0, prev - budget_cents)) * 1_000_000
    if excess_micro <= 0:
        return
    key = f"ai:{tenant_id}:{_day()}"
    doc = await db["llm_daily_usage"].find_one({"_id": key}, {"credit_debt_micro": 1}) or {}
    debt = float(doc.get("credit_debt_micro") or 0) + excess_micro
    cents = int(debt // 1_000_000)
    if cents > 0 and await ai_credits.consume(tenant_id, cents):
        debt -= cents * 1_000_000
    await db["llm_daily_usage"].update_one({"_id": key}, {"$set": {"credit_debt_micro": debt}})


async def measured(db=None, days: int = 30) -> dict:
    """Real cost across ALL tenants for the last N days → avg cost per AI question (cents)."""
    db = db if db is not None else shared_db()
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
    rows = await db["llm_daily_usage"].aggregate([
        # ΜΟΝΟ ερωτήσεις πελατών: εξαιρούνται οι εσωτερικές ψευδο-tenant εργασίες (__…__), γιατί
        # έχουν εντελώς διαφορετικό προφίλ (haiku, μαζικά) και θα νόθευαν το «κόστος ανά ερώτηση».
        {"$match": {"_id": {"$regex": "^ai:(?!__)"}, "at": {"$gte": cutoff}}},
        {"$group": {"_id": None, "cost_micro": {"$sum": "$cost_micro"},
                    "priced": {"$sum": "$n_priced"}, "tok_in": {"$sum": "$tok_in"},
                    "tok_out": {"$sum": "$tok_out"}}},
    ]).to_list(length=1)
    r = rows[0] if rows else {}
    # ΤΙΜΙΟΣ μέσος όρος: διαιρούμε ΜΟΝΟ με τις τιμολογημένες κλήσεις (n_priced), όχι με ΟΛΕΣ τις
    # ερωτήσεις — αλλιώς οι παλιές (προ-tracking, με 0 κόστος) ρίχνουν πλασματικά τον μέσο όρο.
    priced = int(r.get("priced") or 0)
    cost_cents = (r.get("cost_micro") or 0) / 1_000_000
    return {"days": days, "ai_questions": priced, "cost_cents_total": round(cost_cents, 2),
            "cost_cents_per_q": round(cost_cents / priced, 4) if priced else None,
            "tok_in": int(r.get("tok_in") or 0), "tok_out": int(r.get("tok_out") or 0)}


async def pricing_suggestion(db=None, days: int = 30) -> dict:
    """Measured cost/question + cost-plus suggested customer price/question (για την τιμολόγηση credits)."""
    db = db if db is not None else shared_db()
    cfg = await config(db)
    m = await measured(db, days)
    cpq = m.get("cost_cents_per_q")
    factor = 1 + cfg["margin_pct"] / 100
    suggested_q = round(cpq * factor, 4) if cpq is not None else None
    return {"margin_pct": cfg["margin_pct"], "models": cfg["models"], "measured": m,
            "suggested_price_per_q_cents": suggested_q}


def cached_system(text: str) -> list[dict]:
    """System prompt ως block με cache_control → η Anthropic κρατά το πρόθεμα (system + tools) σε cache.

    ΓΙΑΤΙ: ο Copilot ξαναστέλνει ~8.500 tokens (system + 20 εργαλεία) σε ΚΑΘΕ κλήση, και μία ερώτηση
    κάνει έως 6 κλήσεις (tool loop). Χωρίς cache χρεώνονται όλα με πλήρη τιμή input· με cache η
    ανάγνωση κοστίζει ~10× λιγότερο. Μετρημένο όφελος: ~45% στο συνολικό κόστος ανά ερώτηση.
    Το cache_control μπαίνει στο system (τελευταίο του προθέματος) ώστε να καλύπτει ΚΑΙ τα tools.
    """
    return [{"type": "text", "text": text, "cache_control": {"type": "ephemeral"}}]
