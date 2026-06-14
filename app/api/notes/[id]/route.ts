import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, notes } from "@/db";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const b = await req.json();
  const patch: Record<string, any> = { updatedAt: new Date() };
  if (b.title !== undefined) patch.title = b.title;
  if (b.body !== undefined) patch.body = b.body;
  if (b.date !== undefined) patch.date = b.date ? new Date(b.date) : null;

  const [row] = await db
    .update(notes)
    .set(patch)
    .where(eq(notes.id, params.id))
    .returning();
  return NextResponse.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await db.delete(notes).where(eq(notes.id, params.id));
  return NextResponse.json({ deleted: true });
}
