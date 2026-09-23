"use client";

/* «Σε ποιον δώσαμε αυτό το κουτί;»

   Ο φαρμακοποιός κρατά ένα κουτί ή ένα κουπόνι στο χέρι και θέλει τον πελάτη. Δέχεται ΚΑΙ το
   πλήρες GS1 του 2D ΚΑΙ σκέτη ταινία ΕΟΦ — ο σκάνερ δίνει άλλο string ανά τύπο κουτιού και δεν
   έχει νόημα να ξέρει ο χρήστης τη διαφορά. Ψάχνει και στις εκτελέσεις και στα δανεικά: το κουτί
   μπορεί να έφυγε με οποιονδήποτε από τους δύο τρόπους. */

import { useState } from "react";
import Link from "next/link";
import { ScanLine, Loader2, X, UserRound } from "lucide-react";
import { api } from "@/lib/apiClient";
import { useT } from "@/store/prefStore";

type Exec = { external_id: string; executed_at?: string | null; product?: string | null;
              amount_total?: number | null; patient_id?: string | null;
              patient_name?: string | null; amka?: string | null };
type Loan = { _id: string; patient_name?: string | null; patient_id?: string | null;
              status?: string; created_at?: string | null; products?: (string | null)[] };
type Res = { serial?: string | null; batch?: string | null; gtin?: string | null;
             executions: Exec[]; loans: Loan[] };

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric",
                                            hour: "2-digit", minute: "2-digit" }) : "—";
const eur = (c?: number | null) => (c == null ? "" : `${(c / 100).toFixed(2)} €`);

export function CouponLookup() {
  const t = useT();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Res | null>(null);

  async function look(v?: string) {
    const q = (v ?? code).trim();
    if (!q) return;
    setBusy(true);
    try { setRes(await api<Res>(`/prescriptions/by-coupon?code=${encodeURIComponent(q)}`)); }
    catch { setRes({ executions: [], loans: [] }); }
    finally { setBusy(false); }
  }

  const empty = res && !res.executions.length && !res.loans.length;

  return (
    <section className="mb-4 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
      <div className="mb-2 flex items-center gap-2">
        <ScanLine className="h-4 w-4 text-teal-600" />
        <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">
          {t("Σε ποιον δώσαμε αυτό το κουτί;", "Who did we give this box to?")}
        </span>
      </div>
      <div className="flex gap-2">
        <input value={code} autoComplete="off"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); look(); } }}
          placeholder={t("σάρωσε το QR του κουτιού ή την ταινία ΕΟΦ", "scan the box QR or the ΕΟΦ strip")}
          className="block w-full max-w-xl rounded-lg border-2 border-teal-300 bg-teal-50/40 px-3 py-2 text-sm outline-none focus:border-teal-500 dark:border-teal-800 dark:bg-slate-800" />
        <button onClick={() => look()} disabled={busy || !code.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700 disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("Αναζήτηση", "Search")}
        </button>
        {res && (
          <button onClick={() => { setRes(null); setCode(""); }}
            className="rounded-lg border border-slate-300 px-3 text-sm text-slate-500 hover:bg-slate-50 dark:border-slate-600">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {res?.serial && (
        <p className="mt-2 text-xs text-slate-400">
          {t("Κωδικός", "Code")}: <span className="font-mono">{res.serial}</span>
          {res.batch ? ` · ${t("παρτίδα", "batch")} ${res.batch}` : ""}
          {res.gtin ? ` · GTIN ${res.gtin}` : ""}
        </p>
      )}

      {empty && (
        <p className="mt-3 rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400">
          {t("Δεν βρέθηκε σε καμία εκτέλεση ή δανεικό αυτού του φαρμακείου.",
             "Not found in any execution or loan of this pharmacy.")}
        </p>
      )}

      {!!res?.executions.length && (
        <div className="mt-3 space-y-1.5">
          {res.executions.map((e) => (
            <div key={e.external_id + (e.product || "")} className="flex flex-wrap items-center gap-2 rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800">
              <UserRound className="h-4 w-4 text-slate-400" />
              {e.patient_id ? (
                <Link href={`/intelligence/profile?patient_id=${encodeURIComponent(e.patient_id)}`}
                  className="font-medium text-brand-700 hover:underline dark:text-brand-400">{e.patient_name || "—"}</Link>
              ) : <span className="font-medium">{e.patient_name || "—"}</span>}
              {e.amka && <span className="text-xs text-slate-400">ΑΜΚΑ {e.amka}</span>}
              <span className="text-slate-500">{e.product}</span>
              <span className="ml-auto text-xs text-slate-400">
                {fmt(e.executed_at)} · <Link href={`/prescriptions/${encodeURIComponent(e.external_id)}`}
                  className="text-brand-600 hover:underline">{e.external_id}</Link> {eur(e.amount_total)}
              </span>
            </div>
          ))}
        </div>
      )}

      {!!res?.loans.length && (
        <div className="mt-3 space-y-1.5">
          {res.loans.map((l) => (
            <div key={l._id} className="flex flex-wrap items-center gap-2 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900/50 dark:bg-amber-950/20">
              <span className="rounded-full bg-amber-200 px-2 py-0.5 text-[11px] font-semibold text-amber-900">
                {t("δανεικό", "loan")}{l.status === "open" ? "" : ` · ${l.status}`}
              </span>
              <span className="font-medium text-slate-800 dark:text-slate-100">{l.patient_name}</span>
              <span className="text-slate-500">{(l.products || []).filter(Boolean).join(", ")}</span>
              <span className="ml-auto text-xs text-slate-400">{fmt(l.created_at)}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
