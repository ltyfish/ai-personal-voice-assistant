import { NextRequest, NextResponse } from "next/server";
import { asc, eq } from "drizzle-orm";
import { db, subtasks } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/subtasks            → all subtasks (the UI groups them by taskId)
// GET /api/subtasks?taskId=…   → just one task's subtasks
export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get("taskId");
  const rows = taskId
    ? await db.select().from(subtasks).where(eq(subtasks.taskId, taskId)).orderBy(asc(subtasks.position), asc(subtasks.createdAt))
    : await db.select().from(subtasks).orderBy(asc(subtasks.position), asc(subtasks.createdAt));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  if (!b.taskId || !b.title) {
    return NextResponse.json({ error: "taskId and title are required" }, { status: 400 });
  }
  const [row] = await db
    .insert(subtasks)
    .values({
      taskId: b.taskId,
      title: b.title,
      priority: b.priority ?? "medium",
      dueDate: b.dueDate ? new Date(b.dueDate) : null,
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
