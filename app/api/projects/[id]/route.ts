import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, projects } from "@/db";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const b = await req.json();
  const patch: Record<string, any> = { updatedAt: new Date() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.improvements !== undefined) patch.improvements = b.improvements;
  if (b.improvementTimes !== undefined) patch.improvementTimes = b.improvementTimes;
  if (b.done !== undefined) patch.done = b.done;

  const [row] = await db
    .update(projects)
    .set(patch)
    .where(eq(projects.id, params.id))
    .returning();
  return NextResponse.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await db.delete(projects).where(eq(projects.id, params.id));
  return NextResponse.json({ deleted: true });
}
