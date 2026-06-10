"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Eye, EyeOff } from "lucide-react";
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

const inputCls =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-slate-900 focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-500 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";
const errCls = "border-red-400 focus:border-red-500 focus:ring-red-400";

export default function RegisterPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [showPw, setShowPw] = useState(false);

  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    mode: "onTouched", // validate on blur → earlier, clearer feedback
    defaultValues: { pharmacy_name: "", country: "GR", full_name: "", email: "", password: "" },
  });

  async function onSubmit(values: FormValues) {
    setServerError(null);
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        setError(issue.path[0] as keyof FormValues, { message: issue.message });
      }
      return;
    }
    try {
      const res = await api<RegisterResponse>("/onboarding/register", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      if (typeof window !== "undefined") {
        window.localStorage.setItem("access_token", res.access_token);
        window.localStorage.setItem("refresh_token", res.refresh_token);
      }
      router.push("/onboarding");
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setServerError("Το email χρησιμοποιείται ήδη.");
        setError("email", { message: "Το email χρησιμοποιείται ήδη" });
      } else {
        setServerError("Η εγγραφή απέτυχε. Δοκιμάστε ξανά.");
      }
    }
  }

  // keep label↔input association + aria wiring consistent across fields
  function fieldProps(name: keyof FormValues) {
    const hasErr = !!errors[name];
    return {
      id: name,
      "aria-invalid": hasErr,
      "aria-describedby": hasErr ? `${name}-error` : undefined,
      className: `${inputCls} ${hasErr ? errCls : ""}`,
    };
  }
  function FieldError({ name }: { name: keyof FormValues }) {
    if (!errors[name]) return null;
    return (
      <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
        {errors[name]?.message}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <h1 className="mb-1 text-lg font-bold text-slate-900 dark:text-slate-100">Εγγραφή Φαρμακείου</h1>
      <p className="mb-5 text-sm text-slate-500 dark:text-slate-400">Στατιστική ανάλυση εκτελέσεων συνταγών</p>

      <form className="space-y-4" onSubmit={handleSubmit(onSubmit)} noValidate>
        <div>
          <label htmlFor="pharmacy_name" className="mb-1 block text-sm text-slate-600 dark:text-slate-300">Όνομα φαρμακείου</label>
          <input type="text" autoComplete="organization" {...register("pharmacy_name")} {...fieldProps("pharmacy_name")} />
          <FieldError name="pharmacy_name" />
        </div>

        <div>
          <label htmlFor="country" className="mb-1 block text-sm text-slate-600 dark:text-slate-300">Χώρα</label>
          <select {...register("country")} {...fieldProps("country")}>
            <option value="GR">Ελλάδα</option>
            <option value="CY">Κύπρος</option>
          </select>
          <FieldError name="country" />
        </div>

        <div>
          <label htmlFor="full_name" className="mb-1 block text-sm text-slate-600 dark:text-slate-300">Ονοματεπώνυμο</label>
          <input type="text" autoComplete="name" {...register("full_name")} {...fieldProps("full_name")} />
          <FieldError name="full_name" />
        </div>

        <div>
          <label htmlFor="email" className="mb-1 block text-sm text-slate-600 dark:text-slate-300">Email</label>
          <input type="email" autoComplete="email" {...register("email")} {...fieldProps("email")} />
          <FieldError name="email" />
        </div>

        <div>
          <label htmlFor="password" className="mb-1 block text-sm text-slate-600 dark:text-slate-300">Κωδικός</label>
          <div className="relative">
            <input
              type={showPw ? "text" : "password"}
              autoComplete="new-password"
              {...register("password")}
              {...fieldProps("password")}
              className={`${fieldProps("password").className} pr-10`}
            />
            <button
              type="button"
              onClick={() => setShowPw((s) => !s)}
              aria-label={showPw ? "Απόκρυψη κωδικού" : "Εμφάνιση κωδικού"}
              className="absolute inset-y-0 right-0 grid w-10 place-items-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
            >
              {showPw ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          {errors.password ? (
            <FieldError name="password" />
          ) : (
            <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">Τουλάχιστον 8 χαρακτήρες.</p>
          )}
        </div>

        {serverError && (
          <div role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {serverError}
          </div>
        )}

        <button
          type="submit"
          disabled={isSubmitting}
          className="w-full rounded-lg bg-brand-700 px-4 py-2 font-medium text-white hover:bg-brand-800 disabled:opacity-50"
        >
          {isSubmitting ? "Εγγραφή…" : "Εγγραφή"}
        </button>
      </form>

      <div className="mt-4 text-center text-sm text-slate-500 dark:text-slate-400">
        <a href="/login" className="text-brand-700 hover:underline dark:text-brand-400">
          Έχετε ήδη λογαριασμό; Σύνδεση
        </a>
      </div>
    </div>
  );
}
