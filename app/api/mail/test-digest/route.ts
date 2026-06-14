import { requireAuth, json } from "@/lib/mail/auth";
import { runDigest } from "@/lib/mail/digest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Manual trigger to test the digest immediately, bypassing the time-of-day
// check. Visit /api/mail/test-digest (auth required).
async function handle(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  try {
    const result = await runDigest({ force: true });
    return json({ ok: true, ...result });
  } catch (err) {
    return json({ ok: false, error: (err as Error).message }, 500);
  }
}

export const GET = handle;
export const POST = handle;
