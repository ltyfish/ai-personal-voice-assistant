import { runDigest } from "@/lib/mail/digest";
import { json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Cron-invoked hourly (see vercel.json); runDigest() decides internally whether
// the current hour matches a configured digest time.
function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return json({ error: "Unauthorized" }, 401);
  const result = await runDigest();
  return json(result);
}
