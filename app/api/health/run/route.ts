import { NextRequest, NextResponse } from "next/server";
import { runAll, runOne, getSelfHealth } from "@/lib/health";

export const runtime = "nodejs";
export const maxDuration = 30;

// POST { id? } — run one configured check (id) or all of them. Always returns
// this app's self-health alongside, so the UI/voice gets the full picture.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const id = b?.id ? String(b.id) : "";
  const self = await getSelfHealth();
  if (id) {
    const result = await runOne(id);
    if (!result) return NextResponse.json({ error: "unknown check" }, { status: 404 });
    return NextResponse.json({ results: [result], self });
  }
  const results = await runAll();
  return NextResponse.json({ results, self });
}
