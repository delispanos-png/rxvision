"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { api, ApiError } from "@/lib/apiClient";

const schema = z.object({
  pharmacy_name: z.string().min(1, "Απαιτείται όνομα φαρμακείου"),
  country: z.enum(["GR", "CY"]),
  full_name: z.string().min(1, "Απαιτείται ονοματεπώνυμο"),
  email: z.string().email("Μη έγκυρο email"),
  password: z.string().min(8, "Τουλάχιστον 8 χαρακτήρες"),
});

type FormValues = z.infer<typeof schema>;

type RegisterResponse = {
  access_token: string;
  refresh_token: string;
  tenant_id: string;
  country: string;
  ingestion_source: string;
};

export default function RegisterPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { pharmacy_name: "", country: "GR", full_name: "", email: "", password: "" },
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
      const res = await api<RegisterResponse>("/onboarding/register", {
        method: "POST",
        body: JSON.stringify({
          pharmacy_name: parsed.data.pharmacy_name,
          country: parsed.data.country,
          email: parsed.data.email,
          password: parsed.data.password,
          full_name: parsed.data.full_name,
        }),
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem("access_token", res.access_token);
        window.localStorage.setItem("refresh_token", res.refresh_token);
      }
      router.push("/onboarding");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setServerError("Το email χρησιμοποιείται ήδη");
      } else {
        setServerError("Η εγγραφή απέτυχε. Δοκιμάστε ξανά.");
      }
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-1 text-lg font-bold text-slate-900">Εγγραφή Φαρμακείου</h1>
      <p className="mb-5 text-sm text-slate-500">Στατιστική ανάλυση εκτελέσεων συνταγών</p>

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div>
          <label className="mb-1 block text-sm text-slate-600">Όνομα φαρμακείου</label>
          <input
            type="text"
            {...register("pharmacy_name")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
          {errors.pharmacy_name && (
            <p className="mt-1 text-xs text-red-600">{errors.pharmacy_name.message}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-600">Χώρα</label>
          <select
            {...register("country")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          >
            <option value="GR">Ελλάδα</option>
            <option value="CY">Κύπρος</option>
          </select>
          {errors.country && <p className="mt-1 text-xs text-red-600">{errors.country.message}</p>}
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-600">Ονοματεπώνυμο</label>
          <input
            type="text"
            autoComplete="name"
            {...register("full_name")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
          {errors.full_name && (
            <p className="mt-1 text-xs text-red-600">{errors.full_name.message}</p>
          )}
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-600">Email</label>
          <input
            type="email"
            autoComplete="email"
            {...register("email")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
          {errors.email && <p className="mt-1 text-xs text-red-600">{errors.email.message}</p>}
        </div>

        <div>
          <label className="mb-1 block text-sm text-slate-600">Κωδικός</label>
          <input
            type="password"
            autoComplete="new-password"
            {...register("password")}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:border-brand-600 focus:outline-none"
          />
          {errors.password && <p className="mt-1 text-xs text-red-600">{errors.password.message}</p>}
        </div>

        {serverError && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{serverError}</div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {isSubmitting ? "Εγγραφή…" : "Εγγραφή"}
        </button>
      </form>

      <div className="mt-4 text-center text-sm text-slate-500">
        <a href="/login" className="text-brand-700 hover:underline">
          Έχετε ήδη λογαριασμό; Σύνδεση
        </a>
      </div>
    </div>
  );
}
