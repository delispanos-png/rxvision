"use client";

import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { api, ApiError } from "@/lib/apiClient";

const schema = z.object({
  email: z.string().email("Μη έγκυρο email"),
  password: z.string().min(6, "Τουλάχιστον 6 χαρακτήρες"),
});

type FormValues = z.infer<typeof schema>;

type LoginResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export default function LoginPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  // Admin impersonation hand-off: #imp=<access>~<refresh> → store & enter the app.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const h = window.location.hash;
    if (!h.startsWith("#imp=")) return;
    const [access, refresh] = decodeURIComponent(h.slice(5)).split("~");
    if (access && refresh) {
      window.localStorage.setItem("access_token", access);
      window.localStorage.setItem("refresh_token", refresh);
      window.location.hash = "";
      router.replace("/dashboard");
    }
  }, [router]);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] as keyof FormValues;
        setError(field, { message: issue.message });
      }
      return;
    }

    try {
      const res = await api<LoginResponse>("/auth/login", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem("access_token", res.access_token);
        window.localStorage.setItem("refresh_token", res.refresh_token);
      }
      router.push("/dashboard");
    } catch (e) {
      setServerError(
        e instanceof ApiError && e.status === 401
          ? "Λάθος email ή κωδικός."
          : "Η σύνδεση απέτυχε. Δοκιμάστε ξανά."
      );
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-bold text-slate-900">Σύνδεση</h1>
      <p className="mb-5 text-sm text-slate-500">Στατιστική ανάλυση εκτελέσεων συνταγών</p>

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div>
          <label className="mb-1 block text-sm text-slate-600">Email</label>
          <input
            type="email"
            autoComplete="email"
            {...register("email")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-teal-600 focus:outline-none"
          />
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-600">Κωδικός</label>
          <input
            type="password"
            autoComplete="current-password"
            {...register("password")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-teal-600 focus:outline-none"
          />
          {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>}
        </div>

        {serverError && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{serverError}</div>
        )}

        <div className="text-right">
          <a href="/forgot-password" className="text-sm text-teal-700 hover:underline">
            Ξέχασα τον κωδικό;
          </a>
        </div>

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-teal-700 px-4 py-2 font-medium text-white hover:bg-teal-800 disabled:opacity-50"
        >
          {isSubmitting ? "Σύνδεση…" : "Σύνδεση"}
        </button>
      </form>

      <div className="mt-4 space-y-1 text-center text-sm text-slate-500">
        <div>
          <a href="/register" className="text-teal-700 hover:underline">
            Νέο φαρμακείο; Εγγραφή
          </a>
        </div>
        <div>
          <a href="/pricing" className="text-teal-700 hover:underline">
            Δείτε τα πλάνα
          </a>
        </div>
      </div>
    </div>
  );
}
