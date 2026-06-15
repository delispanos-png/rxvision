import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const ADMIN_HOST = "adminpanel.rxvision.gr";

export function middleware(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0] ?? "";
  const { pathname } = request.nextUrl;

  if (host === ADMIN_HOST) {
    const isAdminPath = pathname.startsWith("/admin") || pathname.startsWith("/_next") || pathname.startsWith("/api");
    if (!isAdminPath) {
      const url = request.nextUrl.clone();
      url.pathname = "/admin";
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icons|manifest|sw.js).*)"],
};
