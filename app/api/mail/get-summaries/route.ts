import { listSummaries } from "@/lib/mail/blobs";
import { requireAuth, json } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const filters = {
    date: searchParams.get("date") ?? undefined,
    account: searchParams.get("account") ?? undefined,
    category: searchParams.get("category") ?? undefined,
    urgency: searchParams.get("urgency") ?? undefined,
    reviewed: searchParams.get("reviewed") ?? undefined,
  };

  const summaries = await listSummaries(filters);
  return json(summaries);
}
