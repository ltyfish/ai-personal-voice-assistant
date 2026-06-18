import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tasks } from "@/db";

export const runtime = "nodejs";

// POST { ids: string[] } — ids in their new top-to-bottom order. Each row's
// `position` is rewritten to index*1000 so the manual order persists.
export async function POST(req: NextRequest) {
  const { ids } = await req.json();
  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  }
  await Promise.all(
    ids.map((id: string, i: number) =>
      db.update(tasks).set({ position: i * 1000 }).where(eq(tasks.id, id))
    )
  );
  return NextResponse.json({ ok: true });
}
