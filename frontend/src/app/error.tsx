"use client";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
      <h1 className="text-xl font-semibold text-slate-900">Κάτι πήγε στραβά</h1>
      <p className="mt-2 max-w-md text-sm text-slate-500">
        Παρουσιάστηκε ένα απρόσμενο σφάλμα. Δοκιμάστε ξανά — αν επιμείνει, επικοινωνήστε με την υποστήριξη.
      </p>
      <button
        onClick={() => reset()}
        className="mt-6 inline-block rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        Δοκιμή ξανά
      </button>
    </div>
  );
}
