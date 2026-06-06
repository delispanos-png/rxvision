"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function RootPage() {
  const router = useRouter();
  useEffect(() => {
    const token =
      typeof window !== "undefined" ? window.localStorage.getItem("access_token") : null;
    router.replace(token ? "/dashboard" : "/login");
  }, [router]);
  return <div className="grid min-h-screen place-items-center text-slate-400">RxVision…</div>;
}
