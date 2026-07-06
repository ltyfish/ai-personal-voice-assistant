import qrcode from "qrcode";
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
  const url = getAuthUrl(
    buildOAuthClient(),
    JSON.stringify({ label, accountIndex }),
  );

  const svg = await qrcode.toString(url, {
    type: "svg",
    margin: 1,
    width: 180,
    color: { dark: "#050506", light: "#ffffff" },
  });
  return new Response(svg, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
