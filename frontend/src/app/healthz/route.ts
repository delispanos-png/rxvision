import { NextResponse } from "next/server";

// Load-balancer readiness probe (reached via caddy `/lb-health`, internal-source only).
// Returns 200 ONLY when this node can actually serve: the web (Next.js) server is responding
// (this handler ran) AND the api is reachable. If the api is down/not-ready → 503, so the LB
// marks the node unhealthy and fails traffic over to a healthy node. Never cached.
export const dynamic = "force-dynamic";

const API = process.env.INTERNAL_API_URL ?? "http://api:8000";

export async function GET() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch(`${API}/health`, { signal: ctrl.signal, cache: "no-store" });
    clearTimeout(timer);
    if (!r.ok) return NextResponse.json({ web: "up", api: "down", api_status: r.status }, { status: 503 });
    return NextResponse.json({ web: "up", api: "up" }, { status: 200 });
  } catch {
    return NextResponse.json({ web: "up", api: "unreachable" }, { status: 503 });
  }
}
