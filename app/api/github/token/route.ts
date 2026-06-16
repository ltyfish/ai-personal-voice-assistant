import { NextRequest, NextResponse } from "next/server";
import { getToken, setToken, clearToken, maskToken } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — whether a token is set + a masked preview (never the raw token).
export async function GET() {
  const tok = await getToken();
  const fromEnv = !!process.env.GITHUB_TOKEN;
  return NextResponse.json({ hasToken: !!tok, masked: maskToken(tok), fromEnv });
}

// POST { token } — store the PAT.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const token = String(b?.token || "").trim();
  if (!token) return NextResponse.json({ error: "Token required." }, { status: 400 });
  await setToken(token);
  return NextResponse.json({ ok: true, masked: maskToken(token) });
}

// DELETE — remove the stored token.
export async function DELETE() {
  await clearToken();
  return NextResponse.json({ ok: true });
}
