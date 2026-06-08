import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-6 text-center">
      <div className="text-6xl font-bold text-brand-600">404</div>
      <h1 className="mt-3 text-xl font-semibold text-slate-900">Η σελίδα δεν βρέθηκε</h1>
      <p className="mt-2 max-w-md text-sm text-slate-500">
        Η σελίδα που ζητήσατε δεν υπάρχει ή μετακινήθηκε.
      </p>
      <Link
        href="/dashboard"
        className="mt-6 inline-block rounded-lg bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-700"
      >
        Επιστροφή στο Dashboard
      </Link>
    </div>
  );
}
