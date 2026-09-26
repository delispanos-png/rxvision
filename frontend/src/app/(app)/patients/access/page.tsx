"use client";

/* Ποιος βλέπει ποιον στην Πύλη Πελατών.

   ΤΡΕΙΣ ΔΙΑΦΟΡΕΤΙΚΟΙ ΜΗΧΑΝΙΣΜΟΙ, και η σύγχυσή τους είναι το εύκολο λάθος:
   · ΓΟΝΙΚΗ ΜΕΡΙΜΝΑ — αυτόματη, από τον ρόλο «Γονέας» στην οικογένεια. Παύει ΜΟΝΗ ΤΗΣ στα 18.
   · ΕΞΟΥΣΙΟΔΟΤΗΣΗ — ρητή, από τον ίδιο τον ενήλικο, ανακλητή. Καταγράφεται εδώ.
   · Ο ΕΑΥΤΟΣ ΤΟΥ — πάντα.

   Ενήλικο μέλος οικογένειας ΔΕΝ βλέπει άλλο ενήλικο επειδή «είναι οικογένεια». Η πύλη
   ακολουθεί συγκατάθεση, όχι συγγένεια. */

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, Search, UserRound, ShieldCheck, Trash2, Plus, Baby, KeyRound } from "lucide-react";
import { api } from "@/lib/apiClient";
import { ModuleGuard } from "@/components/layout/ModuleGuard";
import { appAlert, appConfirm, appPrompt } from "@/store/dialogStore";
import { useT } from "@/store/prefStore";

type Hit = { patient_id: string; name: string | null; amka: string | null };
type Auth = { id: string; name: string; at: string; note?: string };
type Access = { granted_by_me: Auth[]; granted_to_me: Auth[] };
type Person = { patient_id: string | null; name: string; deceased: boolean };
type Row = { id: string; at: string; note?: string; grantor: Person; grantee: Person };
type View = { patient_ref: string; name: string; relation: string; via?: string | null;
              deceased: boolean };

const fmt = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

export default function AccessPage() {
  return (
    <ModuleGuard module="patient_portal">
      <Inner />
    </ModuleGuard>
  );
}

function Inner() {
  const t = useT();
  const qc = useQueryClient();
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [who, setWho] = useState<Hit | null>(null);
  // ΔΕΥΤΕΡΗ, ΞΕΧΩΡΙΣΤΗ αναζήτηση: ποιον εξουσιοδοτεί. Η πρώτη εκδοχή ρωτούσε με prompt και
  // κρατούσε ΤΟ ΠΡΩΤΟ αποτέλεσμα — δηλαδή μάντευε άνθρωπο. Σε θέμα πρόσβασης σε δεδομένα
  // υγείας, ο φαρμακοποιός πρέπει να ΔΕΙ και να ΔΙΑΛΕΞΕΙ ρητά.
  const [adding, setAdding] = useState(false);
  const [gTerm, setGTerm] = useState("");
  const [gHits, setGHits] = useState<Hit[]>([]);

  useEffect(() => {
    if (term.trim().length < 2) { setHits([]); return; }
    const id = setTimeout(() => {
      api<{ items: Hit[] }>(`/patient-access/patients?q=${encodeURIComponent(term.trim())}`)
        .then((r) => setHits(r.items)).catch(() => setHits([]));
    }, 300);
    return () => clearTimeout(id);
  }, [term]);

  useEffect(() => {
    if (gTerm.trim().length < 2) { setGHits([]); return; }
    const id = setTimeout(() => {
      api<{ items: Hit[] }>(`/patient-access/patients?q=${encodeURIComponent(gTerm.trim())}`)
        .then((r) => setGHits(r.items.filter((h) => h.patient_id !== who?.patient_id)))
        .catch(() => setGHits([]));
    }, 300);
    return () => clearTimeout(id);
  }, [gTerm, who]);

  // ΟΛΕΣ οι ενεργές εξουσιοδοτήσεις — η λίστα που βλέπεις μόλις ανοίξεις τη σελίδα, χωρίς να
  // χρειαστεί να ξέρεις ποιον να ψάξεις.
  const all = useQuery({ queryKey: ["access-all"],
    queryFn: () => api<{ items: Row[] }>("/patient-access") });

  const access = useQuery({
    queryKey: ["access", who?.patient_id],
    queryFn: () => api<Access>(`/patient-access/for-patient/${who!.patient_id}`),
    enabled: !!who,
  });
  const views = useQuery({
    queryKey: ["views", who?.patient_id],
    queryFn: () => api<{ items: View[] }>(`/patient-access/viewable/${who!.patient_id}`),
    enabled: !!who,
  });

  const reload = () => {
    qc.invalidateQueries({ queryKey: ["access"] });
    qc.invalidateQueries({ queryKey: ["views"] });
    qc.invalidateQueries({ queryKey: ["access-all"] });
  };

  async function grantTo(target: Hit) {
    if (!who) return;
    if (!(await appConfirm(
      t(`Ο/Η ${target.name} θα μπορεί να βλέπει την καρτέλα του/της ${who.name} στην πύλη. Συνεχίζουμε;`,
        `${target.name} will be able to view ${who.name} in the portal. Continue?`)))) return;
    const note = await appPrompt(t("Σημείωση (π.χ. «κόρη, φροντίζει τα φάρμακα»)",
                                   "Note (e.g. daughter, handles medication)"));
    const res = await api<{ ok: boolean; error?: string }>("/patient-access/grant", {
      method: "POST",
      body: JSON.stringify({ grantor_patient_id: who.patient_id,
                             grantee_patient_id: target.patient_id, note: note || "" }),
    });
    if (!res.ok) {
      await appAlert(
        res.error === "grantor_minor"
          ? t("Ο ανήλικος δεν δίνει εξουσιοδότηση — ισχύει η γονική μέριμνα, που είναι αυτόματη.",
              "A minor cannot grant — parental responsibility applies automatically.")
        : res.error === "deceased" ? t("Ο ασφαλισμένος είναι θανών.", "This person is deceased.")
        : res.error === "already" ? t("Υπάρχει ήδη.", "Already exists.")
        : res.error === "self" ? t("Δεν εξουσιοδοτεί τον εαυτό του.", "Cannot authorise themselves.")
        : t("Δεν καταχωρήθηκε.", "Not saved."));
      return;
    }
    setAdding(false); setGTerm(""); setGHits([]);
    reload();
  }

  async function revoke(a: Auth) {
    if (!(await appConfirm(t(`Ανάκληση της πρόσβασης του/της ${a.name};`,
      `Revoke access for ${a.name}?`), { danger: true }))) return;
    await api(`/patient-access/${a.id}`, { method: "DELETE" });
    reload();
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold text-slate-800 dark:text-slate-100">
          <Eye className="h-5 w-5 text-rose-500" /> {t("Ποιος βλέπει ποιον", "Who sees whom")}
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          {t("Πρόσβαση στην Πύλη Πελατών: γονική μέριμνα για ανήλικα παιδιά, και εξουσιοδοτήσεις φροντίδας για ενήλικες.",
             "Patient-portal access: parental responsibility for minors, and care authorisations for adults.")}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input value={term} onChange={(e) => setTerm(e.target.value)}
            placeholder={t("Ασφαλισμένος — όνομα ή ΑΜΚΑ…", "Patient — name or AMKA…")}
            className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-800" />
        </div>
        {hits.length > 0 && (
          <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 dark:divide-slate-800 dark:border-slate-700">
            {hits.map((h) => (
              <li key={h.patient_id}>
                <button onClick={() => { setWho(h); setTerm(""); setHits([]); }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                  <UserRound className="h-4 w-4 shrink-0 text-slate-400" />
                  <span className="truncate">{h.name || "—"}</span>
                  <span className="ml-auto shrink-0 text-xs text-slate-400">{h.amka || ""}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {!who ? (
        <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
          <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
            <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
              <ShieldCheck className="h-4 w-4 text-emerald-500" />
              {t("Ενεργές εξουσιοδοτήσεις", "Active authorisations")}
              {!!all.data?.items.length && (
                <span className="ml-auto rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 dark:bg-slate-800">
                  {all.data.items.length}
                </span>
              )}
            </div>
            <p className="mt-0.5 text-xs text-slate-400">
              {t("Όσοι έχουν δώσει ρητή συγκατάθεση. Η γονική μέριμνα σε ανήλικα δεν χρειάζεται δήλωση — ισχύει αυτόματα.",
                 "Everyone who gave explicit consent. Parental access to minors is automatic and not listed here.")}
            </p>
          </div>
          {all.isLoading ? (
            <div className="p-8 text-center text-sm text-slate-400">{t("Φόρτωση…", "Loading…")}</div>
          ) : !all.data?.items.length ? (
            <div className="p-8 text-center text-sm text-slate-500">
              {t("Καμία εξουσιοδότηση ακόμη. Βρες έναν ασφαλισμένο από πάνω για να καταχωρήσεις.",
                 "No authorisations yet. Find a patient above to add one.")}
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {all.data.items.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
                  <button onClick={() => r.grantor.patient_id &&
                            setWho({ patient_id: r.grantor.patient_id, name: r.grantor.name, amka: null })}
                    className="font-medium text-slate-800 hover:text-rose-600 dark:text-slate-100">
                    {r.grantor.name}
                  </button>
                  <span className="text-slate-400">{t("έδωσε πρόσβαση σε", "granted access to")}</span>
                  <button onClick={() => r.grantee.patient_id &&
                            setWho({ patient_id: r.grantee.patient_id, name: r.grantee.name, amka: null })}
                    className="font-medium text-slate-800 hover:text-rose-600 dark:text-slate-100">
                    {r.grantee.name}
                  </button>
                  {r.note && <span className="truncate text-slate-500">· {r.note}</span>}
                  <span className="ml-auto text-xs text-slate-400">{t("από", "since")} {fmt(r.at)}</span>
                  <button onClick={() => revoke({ id: r.id, name: r.grantee.name, at: r.at })}
                    title={t("Ανάκληση", "Revoke")}
                    className="text-slate-300 hover:text-rose-500">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
            <button onClick={() => setWho(null)}
              className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 dark:border-slate-700">
              ← {t("Όλες", "All")}
            </button>
            <UserRound className="h-5 w-5 text-slate-400" />
            <span className="text-lg font-semibold text-slate-800 dark:text-slate-100">{who.name}</span>
            <span className="text-xs text-slate-400">{who.amka}</span>
            <button onClick={() => { setAdding((v) => !v); setGTerm(""); setGHits([]); }}
              className="ml-auto inline-flex items-center gap-2 rounded-xl bg-rose-600 px-3 py-2 text-sm font-semibold text-white hover:bg-rose-700">
              <Plus className="h-4 w-4" /> {t("Νέα εξουσιοδότηση", "New authorisation")}
            </button>
          </div>

          {adding && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50/40 p-4 dark:border-rose-900 dark:bg-rose-950/10">
              <p className="mb-2 text-sm font-medium text-slate-700 dark:text-slate-200">
                {t(`Ποιον εξουσιοδοτεί ο/η ${who.name} να βλέπει την καρτέλα του/της;`,
                   `Whom does ${who.name} authorise to view their record?`)}
              </p>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
                <input autoFocus value={gTerm} onChange={(e) => setGTerm(e.target.value)}
                  placeholder={t("Όνομα ή ΑΜΚΑ…", "Name or AMKA…")}
                  className="w-full rounded-xl border border-slate-200 py-2 pl-9 pr-3 text-sm dark:border-slate-700 dark:bg-slate-800" />
              </div>
              {gTerm.trim().length >= 2 && gHits.length === 0 && (
                <p className="mt-2 text-xs text-slate-500">
                  {t("Δεν βρέθηκε ασφαλισμένος. Πρέπει να υπάρχει ήδη στο φαρμακείο σου.",
                     "No patient found. They must already exist in your pharmacy.")}
                </p>
              )}
              {gHits.length > 0 && (
                <ul className="mt-2 max-h-56 divide-y divide-slate-100 overflow-auto rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
                  {gHits.map((h) => (
                    <li key={h.patient_id}>
                      <button onClick={() => grantTo(h)}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800">
                        <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-500" />
                        <span className="truncate">{h.name || "—"}</span>
                        <span className="ml-auto shrink-0 text-xs text-slate-400">{h.amka || ""}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <Panel title={t("Βλέπει την καρτέλα του/της", "Can view this person")}
                 icon={<KeyRound className="h-4 w-4 text-slate-400" />}
                 hint={t("Όποιος εμφανίζεται εδώ μπορεί να δει τις συνταγές του/της μέσα από την πύλη.",
                         "Anyone listed here can see their prescriptions in the portal.")}>
            {/* ΠΡΟΣΟΧΗ ΣΤΗ ΦΟΡΑ: «ποιος βλέπει ΑΥΤΟΝ» = οι εξουσιοδοτήσεις που έδωσε Ο ΙΔΙΟΣ
                (`granted_by_me`, με το όνομα του εξουσιοδοτημένου). Το `granted_to_me` είναι το
                αντίθετο — ποιων τις καρτέλες βλέπει αυτός. Η σύγχυση των δύο έδειχνε τη λίστα
                πάντα άδεια, ακριβώς μετά από καταχώριση. */}
            {!access.data?.granted_by_me.length ? (
              <Empty text={t("Κανείς — μόνο ο ίδιος.", "Nobody — only themselves.")} />
            ) : access.data.granted_by_me.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-emerald-500" />
                <span className="font-medium text-slate-700 dark:text-slate-200">{a.name}</span>
                {a.note && <span className="truncate text-slate-500">{a.note}</span>}
                <span className="ml-auto text-xs text-slate-400">{t("από", "since")} {fmt(a.at)}</span>
                <button onClick={() => revoke(a)} className="text-slate-300 hover:text-rose-500">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </Panel>

          <Panel title={t("Ο/Η ίδιος/α βλέπει", "This person can view")}
                 icon={<Eye className="h-4 w-4 text-slate-400" />}
                 hint={t("Ανήλικα παιδιά της οικογένειας (αυτόματα) και όσοι τον/την εξουσιοδότησαν.",
                         "Minor children in the family (automatic) and anyone who authorised them.")}>
            {!views.data?.items.length ? (
              <Empty text={t("Κανέναν άλλον.", "Nobody else.")} />
            ) : views.data.items.map((v) => (
              <li key={v.patient_ref} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm">
                {v.relation === "parental"
                  ? <Baby className="h-4 w-4 text-sky-500" />
                  : <ShieldCheck className="h-4 w-4 text-emerald-500" />}
                <span className="font-medium text-slate-700 dark:text-slate-200">{v.name}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600">
                  {v.relation === "parental"
                    ? t(`γονική μέριμνα${v.via ? ` · ${v.via}` : ""}`, "parental responsibility")
                    : t("εξουσιοδότηση", "authorisation")}
                </span>
                {v.deceased && <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] text-slate-600">{t("θανών", "deceased")}</span>}
              </li>
            ))}
          </Panel>

          <p className="px-1 text-xs text-slate-400">
            {t("Η γονική μέριμνα σταματά αυτόματα τη μέρα των 18ων γενεθλίων του παιδιού. Από εκεί και πέρα, πρόσβαση δίνεται μόνο με ρητή εξουσιοδότηση του ίδιου.",
               "Parental access stops automatically on the child's 18th birthday. After that, access requires their own explicit authorisation.")}
          </p>
        </div>
      )}
    </div>
  );
}

function Panel({ title, icon, hint, children }: {
  title: string; icon?: React.ReactNode; hint?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
      <div className="border-b border-slate-100 px-4 py-2.5 dark:border-slate-800">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          {icon}{title}
        </div>
        {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
      </div>
      <ul className="divide-y divide-slate-100 dark:divide-slate-800">{children}</ul>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <li className="px-4 py-6 text-center text-sm text-slate-400">{text}</li>;
}
