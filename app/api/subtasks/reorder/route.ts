import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, subtasks } from "@/db";

export const runtime = "nodejs";

// POST { taskId: string, ids: string[] } — ids are the subtasks that belong to
// `taskId` in their new order. Each is assigned position index*1000 AND re-parented
// to `taskId` (so a subtask dragged in from another task is moved here in one call).
export async function POST(req: NextRequest) {
  const { taskId, ids } = await req.json();
  if (!taskId || !Array.isArray(ids)) {
    return NextResponse.json({ error: "taskId and ids[] required" }, { status: 400 });
  }
  await Promise.all(
    ids.map((id: string, i: number) =>
      db.update(subtasks).set({ position: i * 1000, taskId }).where(eq(subtasks.id, id))
    )
  );
  return NextResponse.json({ ok: true });
}
