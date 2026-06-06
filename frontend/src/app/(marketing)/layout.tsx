export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center text-2xl font-bold text-teal-700">RxVision</div>
        {children}
      </div>
    </div>
  );
}
