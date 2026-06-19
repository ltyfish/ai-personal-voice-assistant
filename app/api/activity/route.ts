import { NextRequest, NextResponse } from "next/server";
import { getActivity, clearActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const maxDuration = 15;

// GET  /api/activity        — newest-first turn history for the Activity card.
// DELETE /api/activity      — wipe the whole log (the card's Clear button).
export async function GET(req: NextRequest) {
  const limit = Math.min(300, Math.max(1, Number(new URL(req.url).searchParams.get("limit")) || 100));
  const items = await getActivity(limit);
  return NextResponse.json({ items });
}

export async function DELETE() {
  const ok = await clearActivity();
  return NextResponse.json({ ok });
}
