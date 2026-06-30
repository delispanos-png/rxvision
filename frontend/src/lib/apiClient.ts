const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

export class ApiError extends Error {
  constructor(public status: number, public problem: unknown) {
    super(`API ${status}`);
  }
}

function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("access_token");
}

function buildHeaders(init: RequestInit): HeadersInit {
  const token = getAccessToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...init.headers,
  };
}

// Access tokens are short-lived (15 min). On a 401 we transparently refresh once
// using the stored refresh token and retry, so an idle tab doesn't blank out.
let refreshing: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const refresh_token = window.localStorage.getItem("refresh_token");
  if (!refresh_token) return false;
  // collapse concurrent 401s into a single refresh round-trip
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token }),
        });
        if (!res.ok) return false;
        const data = (await res.json()) as { access_token: string; refresh_token: string };
        window.localStorage.setItem("access_token", data.access_token);
        window.localStorage.setItem("refresh_token", data.refresh_token);
        return true;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

/** Force a token refresh so freshly-changed entitlements (e.g. a just-activated add-on module) land
 * in the JWT immediately, without waiting for a 401. Returns true on success. */
export async function refreshSession(): Promise<boolean> {
  return refreshAccessToken();
}

function redirectToLogin() {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem("access_token");
  window.localStorage.removeItem("refresh_token");
  if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await fetch(`${API_BASE}${path}`, { ...init, headers: buildHeaders(init) });

  // 401 on a non-auth call → try one refresh + retry before giving up.
  if (res.status === 401 && !path.startsWith("/auth/")) {
    if (await refreshAccessToken()) {
      res = await fetch(`${API_BASE}${path}`, { ...init, headers: buildHeaders(init) });
    }
    if (res.status === 401) {
      redirectToLogin();
      throw new ApiError(401, await res.json().catch(() => null));
    }
  }

  if (!res.ok) {
    throw new ApiError(res.status, await res.json().catch(() => null));
  }
  return res.json() as Promise<T>;
}

/** Multipart upload (FormData) — lets the browser set the boundary; auth + one refresh retry. */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const auth = (): HeadersInit => { const tk = getAccessToken(); return tk ? { Authorization: `Bearer ${tk}` } : {}; };
  let res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: auth(), body: form });
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await fetch(`${API_BASE}${path}`, { method: "POST", headers: auth(), body: form });
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.json() as Promise<T>;
}

/** Authenticated GET returning a Blob (e.g. a scan image) — img tags can't send the
 * bearer token, so we fetch with auth + one refresh retry and hand back the blob. */
export async function apiBlob(path: string): Promise<Blob> {
  const auth = (): HeadersInit => { const tk = getAccessToken(); return tk ? { Authorization: `Bearer ${tk}` } : {}; };
  let res = await fetch(`${API_BASE}${path}`, { headers: auth() });
  if (res.status === 401 && (await refreshAccessToken())) {
    res = await fetch(`${API_BASE}${path}`, { headers: auth() });
  }
  if (!res.ok) throw new ApiError(res.status, null);
  return res.blob();
}

export const queryKeys = {
  dashboardSummary: (from: string, to: string) => ["dashboard", "summary", from, to],
  timeseries: (metric: string, grain: string, from: string, to: string) =>
    ["dashboard", "timeseries", metric, grain, from, to],
  me: () => ["auth", "me"],

  prescriptions: (q: string) => ["prescriptions", "list", q],
  prescriptionsAggregate: (groupBy: string, q: string) => ["prescriptions", "aggregate", groupBy, q],
  prescriptionsTrends: (metric: string, grain: string, months: number) =>
    ["prescriptions", "trends", metric, grain, months],

  doctors: (q: string) => ["doctors", "list", q],
  doctorStats: (id: string) => ["doctors", "stats", id],

  patientsAggregate: (by: string, q: string) => ["patients", "aggregate", by, q],
  patientsRetention: (cohort: string) => ["patients", "retention", cohort],

  icd10Aggregate: (metric: string, q: string) => ["icd10", "aggregate", metric, q],

  profitabilitySummary: (period: string) => ["profitability", "summary", period],
  profitabilityBy: (dim: string, period: string) => ["profitability", "by", dim, period],
  profitabilityLowMargin: (threshold: number) => ["profitability", "low-margin", threshold],

  futureUpcoming: (days: number) => ["future", "upcoming", days],
  futureForecast: (productId: string, horizon: number) => ["future", "forecast", productId, horizon],

  orderSuggestions: () => ["orders", "suggestions"],

  closingControl: (period: string) => ["closing", "control", period],
  closingDiscrepancies: (period: string) => ["closing", "discrepancies", period],
  closingFundTotals: (period: string) => ["closing", "fund-totals", period],

  pharmacyoneSales: (q: string) => ["pharmacyone", "sales", q],
  pharmacyoneBySeller: (q: string) => ["pharmacyone", "by-seller", q],
  pharmacyoneUnexecuted: () => ["pharmacyone", "unexecuted"],

  users: () => ["users", "list"],
  roles: () => ["roles", "list"],
  tenantModules: () => ["tenant", "modules"],
  ingestionJobs: () => ["ingestion", "jobs"],
  subscription: () => ["subscription"],
  subscriptionUsage: () => ["subscription", "usage"],
};
