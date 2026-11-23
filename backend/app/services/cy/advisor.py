"""RxVision Κύπρος: «Επιχειρησιακά» (Σύμβουλος Επιχείρησης) και «Παραγγελία βάσει πρόβλεψης» — ΙΔΙΟ σχήμα
απάντησης με την Ελλάδα (`repositories/advisor.py::business/orders`), ώστε οι οθόνες να δουλεύουν αυτούσιες.

ΚΑΝΕΝΑΣ νέος ορισμός: κάθε αριθμός έρχεται από το κύκλωμα που ήδη τον υπολογίζει στην Κύπρο —
  - έσοδα / εκτελέσεις / πελάτες / απαίτηση ΟΑΥ → `analytics.summary` (Dashboard)
  - κέρδος → `analytics.profitability` (αμοιβή ΟΑΥ + εφημερίες/διορθώσεις + διαφορά ΓεΣΥ−χονδρικής)
  - χαμένες / καθυστερημένες / επερχόμενες συνταγές → `chains` (Ανοιχτές συνταγές)
  - πρόταση παραγγελίας → `insights.reorder` (Πρόταση παραγγελίας)
  - εκκρεμότητες πληρωμής → `settlement` (Εκκαθάριση ΟΑΥ)
Ό,τι στην Ελλάδα στηρίζεται σε ΕΟΠΥΥ/ΗΔΥΚΑ (rebate, υπόλοιπα ταμείων, τιμοκατάλογος υπουργείου, cross-sell
από ελληνικά προϊόντα) ΔΕΝ υπάρχει εδώ — δεν το «προσομοιώνουμε».
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any

from app.repositories.advisor import ATC_L1, _pct, _sort_insights
from app.repositories.cy import CyDispensingRepository
from app.utils.format import eur_gr
from app.utils.masking import mask_name


def _d(v: date | datetime) -> date:
    return v.date() if isinstance(v, datetime) else v


async def _categories(tenant_id: str, df: date, dt: date) -> list[dict[str, Any]]:
    """Τζίρος ανά θεραπευτική κατηγορία (ATC 1ου επιπέδου, από τον κατάλογο Κύπρου), μερίδιο και τάση.
    ΧΩΡΙΣ «περιθώριο»/ετυμηγορία: στο ΓεΣΥ το φάρμακο πληρώνεται στη χονδρική, άρα το περιθώριο ανά
    κατηγορία είναι ≈0 εκ κατασκευής και θα παραπλανούσε."""
    from app.services.cy import atc_link
    from app.services.cy.analytics import window
    lk = await atc_link.lookup()
    repo = CyDispensingRepository(tenant_id=tenant_id)

    async def rows(a: date, b: date) -> dict[str, dict]:
        acc: dict[str, dict] = defaultdict(lambda: {"revenue": 0, "units": 0, "rx": 0})
        for r in await repo.aggregate([{"$match": window(a, b)}, {"$unwind": "$lines"},
                                       {"$match": {"lines.qty_disp": {"$gt": 0}}},
                                       {"$project": {"_id": 0, "ln": "$lines"}}]):
            info = lk.for_line(r["ln"])
            code = (info or {}).get("atc", "")[:1].upper()
            if code not in ATC_L1:
                continue
            acc[code]["revenue"] += int(((r["ln"].get("amounts") or {}).get("total")) or 0)
            acc[code]["units"] += int(r["ln"].get("qty_disp") or 0)
            acc[code]["rx"] += 1
        return acc

    span = dt - df
    cur, prev = await rows(df, dt), await rows(df - span, df)
    total = sum(v["revenue"] for v in cur.values()) or 1
    out = [{"code": c, "name": ATC_L1[c], "revenue": v["revenue"], "gross_profit": None, "margin_pct": None,
            "units": v["units"], "rx": v["rx"], "share_pct": v["revenue"] / total * 100,
            "trend_pct": _pct(v["revenue"], (prev.get(c) or {}).get("revenue", 0)), "verdict": None}
           for c, v in cur.items()]
    return sorted(out, key=lambda x: -x["revenue"])


async def business(tenant_id: str, df: date | datetime, dt: date | datetime, *, demo: bool = False) -> dict[str, Any]:
    from app.services.cy import analytics, settlement
    from app.services.cy import chains as ch
    df, dt = _d(df), _d(dt)
    py = timedelta(weeks=52)                   # «πέρσι» = ίδια μέρα εβδομάδας (όπως στην Ελλάδα)
    cur, prev = await analytics.summary(tenant_id, df, dt), await analytics.summary(tenant_id, df - py, dt - py)
    pc, pp = await analytics.profitability(tenant_id, df, dt), await analytics.profitability(tenant_id, df - py, dt - py)
    gp, gpp = pc["totals"]["total_profit"], pp["totals"]["total_profit"]
    net, netp = pc["totals"]["revenue_net"], pp["totals"]["revenue_net"]
    m = (gp / net * 100) if (gp is not None and net) else None
    mp = (gpp / netp * 100) if (gpp is not None and netp) else None
    ins: list[dict] = []

    def add(sev, icon, title, detail, metric=None, cta=None):
        ins.append({"severity": sev, "icon": icon, "title": title, "detail": detail, "metric": metric, "cta": cta})

    d_rev = _pct(cur["value"], prev["value"])
    if d_rev is not None and d_rev <= -10:
        add("critical", "trending-down", "Πτώση αξίας εκτελέσεων",
            f"Η αξία των εκτελέσεων ΓεΣΥ έπεσε {abs(d_rev):.0f}% σε σχέση με πέρσι (ίδια περίοδος). Ξεκίνα από όσους "
            "καθυστερούν και τους χαμένους πελάτες.", f"{d_rev:+.0f}%", {"label": "Χαμένοι πελάτες", "href": "/cy/lost"})
    elif d_rev is not None and d_rev >= 10:
        add("positive", "trending-up", "Άνοδος αξίας εκτελέσεων",
            f"Η αξία των εκτελέσεων αυξήθηκε {d_rev:.0f}% έναντι πέρσι. Κράτα ό,τι δουλεύει.", f"{d_rev:+.0f}%")
    d_rx = _pct(cur.get("executions", 0), prev.get("executions", 0))   # (κλειδί σύνοψης, όχι συλλογή)
    if d_rx is not None and d_rx <= -10:
        add("warning", "trending-down", "Λιγότερες εκτελέσεις",
            f"{abs(d_rx):.0f}% λιγότερες εκτελέσεις ΓεΣΥ vs πέρσι — κάλεσε όσους έχουν φάση που καθυστερεί.",
            f"{d_rx:+.0f}%", {"label": "Ανοιχτές συνταγές", "href": "/cy/open"})
    d_pat = _pct(cur["patient_count"], prev["patient_count"])
    if d_pat is not None and d_pat <= -10:
        add("opportunity", "users", "Λιγότεροι πελάτες",
            f"{abs(d_pat):.0f}% λιγότεροι μοναδικοί πελάτες vs πέρσι — καμπάνια επανενεργοποίησης και πιστότητα.",
            f"{d_pat:+.0f}%", {"label": "Καμπάνιες", "href": "/cy/campaigns"})
    elif d_pat is not None and d_pat >= 10:
        add("positive", "users", "Περισσότεροι πελάτες", f"+{d_pat:.0f}% πελάτες vs πέρσι.", f"{d_pat:+.0f}%")

    # κέρδος: χωρίς εκκαθάριση δεν ξέρουμε την αμοιβή → το λέμε, δεν μαντεύουμε
    if not pc["fee"]["available"]:
        add("info", "wallet", "Το κέρδος σου θέλει την εκκαθάριση ΟΑΥ",
            "Στο ΓεΣΥ το κέρδος είναι η αμοιβή ανά συσκευασία. Ανέβασε τα αρχεία πληρωμής του ΟΑΥ για να τη δεις.",
            None, {"label": "Εκκαθάριση ΟΑΥ", "href": "/cy/settlement"})
    elif pc["fee"]["provisional_packages"]:
        add("info", "wallet", "Μέρος της αμοιβής είναι προσωρινό",
            f"{pc['fee']['provisional_packages']} συσκευασίες υπολογίζονται με την τελευταία γνωστή τιμή μονάδας. "
            "Γίνονται ακριβείς μόλις ανεβάσεις την εκκαθάριση του μήνα.", None,
            {"label": "Εκκαθάριση ΟΑΥ", "href": "/cy/settlement"})
    if pc["totals"]["profit"] < 0 and pc["totals"]["covered_revenue_net"]:
        add("warning", "percent", "Είδη που πληρώνονται κάτω από τη χονδρική",
            f"Η διαφορά ΓεΣΥ − χονδρικής είναι €{eur_gr(-pc['totals']['profit'])} αρνητική — κάποια είδη (συνήθως "
            "αναλώσιμα) τα πληρώνει ο ΟΑΥ κάτω από την τιμή που τα αγοράζεις.", f"€{eur_gr(pc['totals']['profit'])}",
            {"label": "Κερδοφορία", "href": "/cy/profitability"})

    # εκκρεμότητες της τελευταίας εκκαθάρισης
    months = await settlement.months(tenant_id)
    if months:
        last = await settlement.detail(tenant_id, months[0]["month"]) or {}
        rc = last.get("reconcile") or {}
        miss, diff = len(rc.get("missing") or []), len(rc.get("diffs") or [])
        if miss or diff:
            add("warning", "alert-triangle", "Διαφορές στην εκκαθάριση ΟΑΥ",
                f"Στην τελευταία εκκαθάριση: {diff} εκτελέσεις πληρώθηκαν διαφορετικά και {miss} λείπουν από το RxVision.",
                f"{diff + miss}", {"label": "Εκκαθάριση ΟΑΥ", "href": "/cy/settlement"})

    cs = await ch.chains(tenant_id)
    lost = [c for c in cs if c["status"] == "lost"]
    late = [c for c in cs if c["status"] == "late"]
    if lost:
        v = sum(c["value_at_stake_cents"] for c in lost)
        add("opportunity", "alert-triangle", "Συνταγές που χάθηκαν",
            f"{len(lost)} συνταγές με φάσεις που δεν ήρθαν ποτέ — €{eur_gr(v)} σε υπόλοιπες φάσεις. Κάλεσε τους πελάτες.",
            f"€{eur_gr(v)}", {"label": "Χαμένοι πελάτες", "href": "/cy/lost"})
    if late:
        add("warning", "calendar-clock", "Φάσεις που καθυστερούν",
            f"{len(late)} συνταγές έχουν φάση που έπρεπε ήδη να έρθει — μια υπενθύμιση τώρα κρατά τον πελάτη.",
            f"{len(late)}", {"label": "Ανοιχτές συνταγές", "href": "/cy/open"})
    soon = [c for c in cs if c["status"] in ("soon", "upcoming") and c["days_to_due"] <= 30]
    if soon:
        add("opportunity", "calendar-clock", "Επερχόμενη ζήτηση",
            f"{len(soon)} φάσεις ({len({c['patient_ref'] for c in soon})} πελάτες) αναμένονται τις επόμενες 30 ημέρες. "
            "Ετοίμασε απόθεμα και υπενθυμίσεις.", f"{len(soon)}", {"label": "Πρόταση παραγγελίας", "href": "/cy/reorder"})

    top = await analytics.top(tenant_id, df, dt, dim="doctors", limit=1)
    if top and cur["value"]:
        share = top[0]["value"] / cur["value"] * 100
        if share >= 15:
            add("info", "stethoscope", "Εξάρτηση από γιατρό",
                f"Ο/Η {mask_name(top[0].get('name'), demo) or 'κορυφαίος γιατρός'} φέρνει το {share:.0f}% της αξίας. "
                "Καλλιέργησε τη σχέση — αλλά πρόσεξε τη συγκέντρωση.", f"{share:.0f}%",
                {"label": "Ιατροί", "href": "/cy/doctors"})
    _sort_insights(ins)
    return {
        "period": {"from": df.isoformat(), "to": dt.isoformat()},
        "kpis": {
            "revenue": {"value": cur["value"], "delta": _pct(cur["value"], prev["value"])},
            "gross_profit": {"value": gp, "delta": _pct(gp, gpp) if (gp is not None and gpp) else None},
            "margin_pct": {"value": m, "delta": (m - mp) if (m is not None and mp is not None) else None},
            "rx": {"value": cur.get("executions", 0), "delta": d_rx},
            "claimed": {"value": cur["hio"], "delta": _pct(cur["hio"], prev["hio"])},
            "patients": {"value": cur["patient_count"], "delta": d_pat},
        },
        "insights": ins,
        "categories": await _categories(tenant_id, df, dt),
        "cross_sell": [],
        "country": "CY",
    }


async def orders(tenant_id: str, *, lead_days: int = 14, demo: bool = False) -> dict[str, Any]:
    """«Παραγγελία βάσει πρόβλεψης»: η ΙΔΙΑ πρόταση με την «Πρόταση παραγγελίας» (`insights.reorder`) σε σχήμα
    ελληνικής οθόνης, + οι πελάτες που αναμένονται (για υπενθύμιση)."""
    from app.services.cy import chains as ch
    from app.services.cy import insights
    r = await insights.reorder(tenant_id, horizon=lead_days)
    sug = [{"product_id": i["key"], "product_name": i.get("description"), "substance": None,
            "avg_daily": round(i["expected"] / max(1, lead_days), 2), "expected_demand": i["expected"],
            "suggested_qty": i["suggested"], "est_cost": (i.get("best_cents") or 0) * i["suggested"],
            "price_rising": False, "best_supplier": i.get("best_supplier")}
           for i in r["items"] if i["suggested"] > 0]
    up = [c for c in await ch.chains(tenant_id)
          if c["status"] in ("soon", "upcoming", "late") and c["days_to_due"] <= lead_days]
    names = await ch.names_of(tenant_id, {c["patient_ref"] for c in up})
    upcoming = sorted(({"expected_open_date": c["next_due"],
                        "patient_name": mask_name((names.get(c["patient_ref"]) or {}).get("full_name"), demo),
                        "amka": None, "products": c.get("items") or [], "source_barcode": c["prescription_id"]}
                       for c in up), key=lambda u: u["expected_open_date"])
    total_qty = sum(s["suggested_qty"] for s in sug)
    total_cost = sum(s["est_cost"] for s in sug)
    ins: list[dict] = []
    if total_qty:
        ins.append({"severity": "opportunity", "icon": "package-search", "title": "Προτεινόμενη παραγγελία",
                    "detail": f"{len(sug)} σκευάσματα · {total_qty} τεμάχια · κόστος €{eur_gr(total_cost)} στον φθηνότερο "
                              f"διαθέσιμο προμηθευτή, για τις επόμενες {lead_days} ημέρες.",
                    "metric": f"€{eur_gr(total_cost)}", "cta": {"label": "Πρόταση παραγγελίας", "href": "/cy/reorder"}})
    if r["summary"].get("saving_cents"):
        ins.append({"severity": "positive", "icon": "tag", "title": "Γλιτώνεις με τον φθηνότερο προμηθευτή",
                    "detail": f"€{eur_gr(r['summary']['saving_cents'])} λιγότερα αν πάρεις κάθε είδος από τον φθηνότερο "
                              "αντί για τον ακριβότερο.", "metric": f"€{eur_gr(r['summary']['saving_cents'])}",
                    "cta": {"label": "Σύγκριση προμηθευτών", "href": "/cy/reorder"}})
    if upcoming:
        ins.append({"severity": "opportunity", "icon": "calendar-clock", "title": "Πελάτες για υπενθύμιση",
                    "detail": f"{len(upcoming)} φάσεις συνταγών τις επόμενες {lead_days} ημέρες — ειδοποίησε τους πελάτες "
                              "για να εξασφαλίσεις την πώληση.", "metric": f"{len(upcoming)}",
                    "cta": {"label": "Ανοιχτές συνταγές", "href": "/cy/open"}})
    _sort_insights(ins)
    return {"kpis": {"items": len(sug), "qty": total_qty, "cost": total_cost, "rising": 0},
            "insights": ins, "suggestions": sug[:50], "upcoming": upcoming[:50], "cross_sell": [], "country": "CY"}
