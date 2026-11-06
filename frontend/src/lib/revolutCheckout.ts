/** Το παράθυρο της Revolut για ΑΠΟΘΗΚΕΥΣΗ κάρτας (εγγραφή, αλλαγή κάρτας). Το `savePaymentMethodFor:
 * "merchant"` είναι η άδεια του πελάτη για αυτόματες χρεώσεις: χωρίς αυτό η ανανέωση δεν έχει τι να χρεώσει.
 * Επιστρέφει τι έγινε πραγματικά, γιατί ακύρωση ή μπλοκαρισμένο script ΔΕΝ είναι επιτυχία. */
export type RevolutResult = "success" | "cancel" | "error";

type Popup = { payWithPopup: (o: Record<string, unknown>) => void };
type Win = { RevolutCheckout?: (t: string, m: string) => Promise<Popup> };

export function saveCardWithRevolut(token: string, mode: string): Promise<RevolutResult> {
  return new Promise((resolve) => {
    const w = window as unknown as Win;
    const run = () => {
      if (!w.RevolutCheckout) return resolve("error");
      w.RevolutCheckout(token, mode === "live" ? "prod" : "sandbox")
        .then((rc) => rc.payWithPopup({
          savePaymentMethodFor: "merchant",
          onSuccess: () => resolve("success"), onError: () => resolve("error"), onCancel: () => resolve("cancel"),
        }))
        .catch(() => resolve("error"));
    };
    if (w.RevolutCheckout) return run();
    const el = document.createElement("script");
    el.src = mode === "live" ? "https://merchant.revolut.com/embed.js" : "https://sandbox-merchant.revolut.com/embed.js";
    el.onload = run; el.onerror = () => resolve("error");
    document.body.appendChild(el);
  });
}
