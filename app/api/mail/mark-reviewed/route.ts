import { getSummary, setSummary } from "@/lib/mail/blobs";
import { requireAuth, json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const { emailId, date, reviewed } = await req.json();
  const summary = await getSummary(date, emailId);
  if (!summary) return json({ error: "Not found" }, 404);

  summary.reviewed = reviewed;
  await setSummary(date, emailId, summary);
  return json({ ok: true });
}
