// Κλείδωμα εξαγωγών σε ΔΟΚΙΜΑΣΤΙΚΗ συνδρομή — ΕΝΑ σημείο για όλα τα κυκλώματα.
// Η σημαία έρχεται από το /auth/me (exports_locked) μέσω του ExportGateSync στο layout,
// και ελέγχεται μέσα στις downloadCsv/downloadXlsx/downloadPdf ώστε να καλύπτεται κάθε κουμπί.
import { appConfirm } from "@/store/dialogStore";
import { usePref } from "@/store/prefStore";

let locked = false;

export function setExportsLocked(v: boolean): void {
  locked = v;
}

/** true → η εξαγωγή μπλοκαρίστηκε (και ο χρήστης ενημερώθηκε). */
export function exportBlocked(): boolean {
  if (!locked) return false;
  const en = usePref.getState().locale === "en";
  void appConfirm(
    en
      ? "Exporting to Excel, PDF and CSV is available once your subscription is activated."
      : "Η εξαγωγή σε Excel, PDF και CSV είναι διαθέσιμη με την ενεργοποίηση της συνδρομής σας.",
    {
      title: en ? "Export locked during the trial" : "Η εξαγωγή είναι κλειδωμένη στη δοκιμή",
      confirmText: en ? "Activate subscription" : "Ενεργοποίηση συνδρομής",
      cancelText: en ? "Not now" : "Όχι τώρα",
    },
  ).then((go) => { if (go) window.location.href = "/settings/billing"; });
  return true;
}
