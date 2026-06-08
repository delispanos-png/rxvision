"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { DialogHost } from "@/components/ui/DialogHost";
import { ToastHost } from "@/components/ui/ToastHost";

export function Providers({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 60_000, retry: 1 } },
      })
  );
  return (
    <QueryClientProvider client={client}>
      {children}
      <DialogHost />
      <ToastHost />
    </QueryClientProvider>
  );
}
