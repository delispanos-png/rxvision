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
    return int((in_tok + cwrite_tok) * prices.get("in", 0)
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
                      "n_priced": 1}},   # πόσες κλήσεις τιμολογήθηκαν (για ΤΙΜΙΟ μέσο όρο κόστους)
            upsert=True)
    except Exception:  # noqa: BLE001 — cost metering must never break an AI answer
        pass


async def measured(db=None, days: int = 30) -> dict:
    """Real cost across ALL tenants for the last N days → avg cost per AI question (cents)."""
    db = db if db is not None else shared_db()
    cutoff = datetime.now(tz=timezone.utc) - timedelta(days=days)
    rows = await db["llm_daily_usage"].aggregate([
        {"$match": {"_id": {"$regex": "^ai:"}, "at": {"$gte": cutoff}}},
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
    """Measured cost/question + cost-plus suggested customer price/question and per-25 block."""
    db = db if db is not None else shared_db()
    cfg = await config(db)
    m = await measured(db, days)
    cpq = m.get("cost_cents_per_q")
    factor = 1 + cfg["margin_pct"] / 100
    suggested_q = round(cpq * factor, 4) if cpq is not None else None
    from app.services.ai_quota import AI_BLOCK
    return {"margin_pct": cfg["margin_pct"], "models": cfg["models"], "measured": m,
            "block": AI_BLOCK,
            "suggested_price_per_q_cents": suggested_q,
            # τιμή μπλοκ αν χρεωνόταν ΟΛΗ η ημερήσια χωρητικότητα του μπλοκ (25/μέρα × 30) cost-plus
            "suggested_block_full_month_cents": round(suggested_q * AI_BLOCK * 30) if suggested_q else None}
