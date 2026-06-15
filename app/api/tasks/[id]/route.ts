import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, tasks, subtasks } from "@/db";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const b = await req.json();
  const patch: Record<string, any> = {};
  if (b.title !== undefined) patch.title = b.title;
  if (b.notes !== undefined) patch.notes = b.notes;
  if (b.done !== undefined) patch.done = b.done;
  if (b.priority !== undefined) patch.priority = b.priority;
  if (b.dueDate !== undefined)
    patch.dueDate = b.dueDate ? new Date(b.dueDate) : null;

  const [row] = await db
    .update(tasks)
    .set(patch)
    .where(eq(tasks.id, params.id))
    .returning();
  return NextResponse.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  // Remove child subtasks first. The FK is declared ON DELETE CASCADE, but the
  // subtasks table may pre-date that constraint, so delete them explicitly to be
  // safe (otherwise orphaned subtasks linger on the calendar).
  await db.delete(subtasks).where(eq(subtasks.taskId, params.id));
  await db.delete(tasks).where(eq(tasks.id, params.id));
  return NextResponse.json({ deleted: true });
}
