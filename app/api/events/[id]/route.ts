import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, events } from "@/db";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const b = await req.json();
  const patch: Record<string, any> = {};
  if (b.title !== undefined) patch.title = b.title;
  if (b.location !== undefined) patch.location = b.location;
  if (b.startTime !== undefined) patch.startTime = new Date(b.startTime);
  if (b.endTime !== undefined) patch.endTime = new Date(b.endTime);

  const [row] = await db
    .update(events)
    .set(patch)
    .where(eq(events.id, params.id))
    .returning();
  return NextResponse.json(row);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  await db.delete(events).where(eq(events.id, params.id));
  return NextResponse.json({ deleted: true });
}
