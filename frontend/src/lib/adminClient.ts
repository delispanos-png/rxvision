// Platform (CloudOn) API client — SEPARATE identity & token storage from the tenant
// app. The back-office never uses a tenant token; it uses a `padmin` token obtained
// from /platform/auth/login and refreshed via /platform/auth/refresh.

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000/api/v1";

const ACCESS_KEY = "padmin_access_token";
const REFRESH_KEY = "padmin_refresh_token";

export class ApiError extends Error {
  constructor(public status: number, public problem: unknown) {
    super(`API ${status}`);
  }
}

export const adminTokens = {
  set(access: string, refresh: string) {
    window.localStorage.setItem(ACCESS_KEY, access);
    window.localStorage.setItem(REFRESH_KEY, refresh);
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
  const token = adminTokens.access;
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
        const res = await fetch(`${API_BASE}/platform/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token }),
        });
        if (!res.ok) return false;
        const d = (await res.json()) as { access_token: string; refresh_token: string };
        adminTokens.set(d.access_token, d.refresh_token);
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

function toLogin() {
  if (typeof window === "undefined") return;
  adminTokens.clear();
  if (!window.location.pathname.startsWith("/admin/login")) window.location.href = "/admin/login";
}

export async function adminApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res = await fetch(`${API_BASE}${path}`, { ...init, headers: headers(init) });
  if ((res.status === 401 || res.status === 403) && !path.startsWith("/platform/auth/")) {
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
