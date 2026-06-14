import { runFetch } from "@/lib/mail/fetch";
import { json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Cron-invoked (see vercel.json). If CRON_SECRET is set, Vercel attaches it as
// `Authorization: Bearer <CRON_SECRET>` — reject anything else.
function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return json({ error: "Unauthorized" }, 401);
  const res = await runFetch();
  return json(res, res.ok ? 200 : 500);
}
