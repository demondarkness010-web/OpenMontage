import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "capclip_session";

/**
 * Give every browser a session token on its first page load, before the page
 * fires parallel API calls. Without this, simultaneous first requests would
 * each create their own workspace on the backend.
 */
export function middleware(req: NextRequest) {
  if (req.cookies.get(COOKIE)) return NextResponse.next();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  // Forward the cookie on this request too, so a first-hit API call already carries it.
  const headers = new Headers(req.headers);
  headers.set("cookie", [req.headers.get("cookie"), `${COOKIE}=${token}`].filter(Boolean).join("; "));
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(COOKIE, token, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico).*)"],
};
