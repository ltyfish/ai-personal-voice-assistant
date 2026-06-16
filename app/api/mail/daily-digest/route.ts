import { runDigest } from "@/lib/mail/digest";
import { runFetch } from "@/lib/mail/fetch";
import { json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

// Cron-invoked hourly (see vercel.json / MAILMIND_CRON.md); runDigest() decides
// internally whether the current hour matches a configured digest time.
function cronAuthorized(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: Request) {
  if (!cronAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  // Fetch-then-digest: poll + summarize the latest inbox FIRST, so the digest
  // reads fresh summaries even if the standalone fetch cron isn't running (the
  // "digest didn't fetch first, so it had nothing to summarize" bug on cloud).
  // Best-effort — a fetch failure must not block sending a digest of whatever
  // summaries already exist. Pass ?fetch=0 to digest existing data only.
  const url = new URL(req.url);
  if (url.searchParams.get("fetch") !== "0") {
    try {
      await runFetch();
    } catch (err) {
      console.error(
        "daily-digest: pre-fetch failed, digesting existing summaries:",
        (err as Error).message
      );
    }
  }

  const result = await runDigest();
  return json(result);
}
