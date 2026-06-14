// Dashboard auth + JSON helper, ported from the Netlify `_auth.js`.
// Returns a Response on failure, or null when authorized.
export function requireAuth(req: Request): Response | null {
  const auth = req.headers.get("authorization") ?? "";
  const token =
    auth.replace("Bearer ", "") ||
    (new URL(req.url).searchParams.get("secret") ?? "");
  if (token !== process.env.DASHBOARD_SECRET) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
