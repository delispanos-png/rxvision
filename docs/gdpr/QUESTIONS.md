# GDPR — open questions (legal/business facts I must NOT invent)

These block only the final legal text, not the code. Docs use clearly-marked
`«[ΠΡΟΣ ΕΠΙΒΕΒΑΙΩΣΗ: …]»` placeholders until answered. Per the workstream rules I keep
working on everything else.

## Must be supplied by CloudOn / legal counsel
1. **CloudOn legal entity** — full company name, legal form (Α.Ε./ΙΚΕ/…), ΑΦΜ/ΓΕΜΗ,
   registered address. (Needed in: Privacy Policy, DPA, RoPA, sub-processor register.)
2. **DPO / privacy contact** — name (or "υπεύθυνος επικοινωνίας"), email, phone, postal
   address. Is a formal DPO appointed (Art.37)? (Large-scale Art.9 health data likely
   triggers the requirement.)
3. **Official company email + privacy mailbox** (e.g. privacy@rxvision.gr / dpo@…).
4. **Statutory MINIMUM retention (the legal-hold floor)** — the retention *period* is now
   **chosen by each pharmacy** (controller) via `/settings/gdpr` → `gdpr_settings.retention_months`;
   it is NOT CloudOn's decision. What legal must confirm is only the **minimum floor** below which
   clinical/tax records may not be deleted:
   - Prescription execution records (φαρμακευτική νομοθεσία / ΕΟΠΥΥ) — minimum years?
   - Tax/accounting (invoices, ΑΑΔΕ/myDATA) — minimum years (typically 5–10y)?
   - audit_logs / security logs — minimum retention?
   (Contact/marketing data has no statutory floor — kept until consent withdrawal or the pharmacy's
   chosen period.)
5. **Controller vs processor confirmation** — confirmed model: pharmacy = controller,
   CloudOn = processor. Any joint-controllership for platform-level analytics?
6. **Sub-processors — exact list + contracts**: confirm Hetzner (region — Helsinki/
   Falkenstein?), Apifon (SMS), the email/SMTP provider identity, Cloudflare. Are DPAs
   signed with each? Any non-EU transfer + SCCs?
7. **Lawful basis for Art.9 health-data processing** — confirm the chosen basis
   (e.g. Art.9.2.h management of health systems / 9.2.i public health, vs explicit consent)
   and the national-law hook.
8. **Supervisory authority** — Ελληνική Αρχή Προστασίας Δεδομένων (ΑΠΔΠΧ); confirm breach
   notification channel/contact used in the breach procedure.

## Code/process questions (lower priority)
9. Should erasure also purge the patient from external backups/snapshots, and within what
   window? (Currently: documented retention + the erasure stays in the primary DB scope.)
10. Is there an existing cookie/analytics tracker on the marketing site that needs the
    consent banner (stretch goal C)?
