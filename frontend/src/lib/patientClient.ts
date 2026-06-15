// Patient-portal API client — SEPARATE identity & token storage from the tenant/admin apps.
// Uses a `pat` token from /patient/auth/login|register, refreshed via /patient/auth/refresh.

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

const ACCESS_KEY = "patient_access_token";
const REFRESH_KEY = "patient_refresh_token";

export class ApiError extends Error {
  constructor(public status: number, public problem: unknown) {
    super(`API ${status}`);
  }
}

export const patientTokens = {
  set(access: string | null, refresh: string | null) {
    if (access) window.localStorage.setItem(ACCESS_KEY, access);
    else window.localStorage.removeItem(ACCESS_KEY);
    if (refresh) window.localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    window.localStorage.removeItem(ACCESS_KEY);
    window.localStorage.removeItem(REFRESH_KEY);
  },
  get access() {
    return typeof window === "undefined" ? null : window.localStorage.getItem(ACCESS_KEY);
  },
};

function headers(init: RequestInit): HeadersInit {
  const token = patientTokens.access;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...init.headers,
  };
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const refresh_token = window.localStorage.getItem(REFRESH_KEY);
  if (!refresh_token) return false;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const res = await fetch(`${API_BASE}/patient/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token }),
        });
        if (!res.ok) return false;
        const d = (await res.json()) as { access_token: string | null; refresh_token: string };
        patientTokens.set(d.access_token, d.refresh_token);
        return !!d.access_token;
      } catch {
        return false;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

function toLogin() {
  if (typeof window === "undefined") return;
  patientTokens.clear();
  if (!window.location.pathname.startsWith("/portal/login")) window.location.href = "/portal/login";
}

export async function patientApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await fetch(`${API_BASE}${path}`, { ...init, headers: headers(init) });
  if ((res.status === 401 || res.status === 403) && !path.startsWith("/patient/auth/")) {
    if (await refresh()) {
      res = await fetch(`${API_BASE}${path}`, { ...init, headers: headers(init) });
    }
    if (res.status === 401 || res.status === 403) {
      toLogin();
      throw new ApiError(res.status, await res.json().catch(() => null));
    }
  }
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.json() as Promise<T>;
}

// Raw helper for the auth endpoints (no token, returns the session payload).
export async function patientAuth<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
  return res.json() as Promise<T>;
}
