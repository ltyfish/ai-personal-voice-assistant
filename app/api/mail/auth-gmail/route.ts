import { buildOAuthClient, getAuthUrl } from "@/lib/mail/gmail";
import { requireAuth } from "@/lib/mail/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const { searchParams } = new URL(req.url);
  const label = searchParams.get("label") ?? "Account";
  const accountIndex = searchParams.get("index") ?? "0";

  const oAuth2Client = buildOAuthClient();
  const url = getAuthUrl(oAuth2Client, JSON.stringify({ label, accountIndex }));

  return Response.redirect(url, 302);
}
