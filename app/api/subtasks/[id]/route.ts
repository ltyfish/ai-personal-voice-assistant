import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, subtasks } from "@/db";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const b = await req.json();
  const patch: Record<string, any> = {};
  if (b.title !== undefined) patch.title = b.title;
  if (b.done !== undefined) patch.done = b.done;
  if (b.priority !== undefined) patch.priority = b.priority;
  if (b.dueDate !== undefined) patch.dueDate = b.dueDate ? new Date(b.dueDate) : null;
  if (b.position !== undefined) patch.position = b.position;
  if (b.taskId !== undefined) patch.taskId = b.taskId; // move to another task

  const [row] = await db
    .update(subtasks)
    .set(patch)
    .where(eq(subtasks.id, params.id))
    .returning();
  return NextResponse.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await db.delete(subtasks).where(eq(subtasks.id, params.id));
  return NextResponse.json({ deleted: true });
}
