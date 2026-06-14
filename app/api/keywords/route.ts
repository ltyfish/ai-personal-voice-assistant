import { NextRequest, NextResponse } from "next/server";
import { getKeywordMap, saveKeywordMap } from "@/lib/keywords";

export const runtime = "nodejs";

// Custom trigger-keyword overrides for the voice agent's abilities. This is
// local productivity config (like /api/tasks), so it needs no DASHBOARD_SECRET.
export async function GET() {
  const keywords = await getKeywordMap();
  return NextResponse.json({ keywords });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const keywords = await saveKeywordMap(body?.keywords ?? {});
    return NextResponse.json({ ok: true, keywords });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "failed to save keywords" },
      { status: 500 }
    );
  }
}
