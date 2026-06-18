import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, projects } from "@/db";

export const runtime = "nodejs";

// POST { ids: string[] } — ids in their new order; rewrites `position`.
export async function POST(req: NextRequest) {
  const { ids } = await req.json();
  if (!Array.isArray(ids)) {
    return NextResponse.json({ error: "ids[] required" }, { status: 400 });
  }
  await Promise.all(
    ids.map((id: string, i: number) =>
      db.update(projects).set({ position: i * 1000 }).where(eq(projects.id, id))
    )
  );
  return NextResponse.json({ ok: true });
}
