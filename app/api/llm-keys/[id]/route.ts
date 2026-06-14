import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, llmKeys } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// PATCH — toggle enabled, edit label, or clear an active cooldown.
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const b = await req.json().catch(() => ({}));
  const set: Record<string, unknown> = {};
  if (typeof b.enabled === "boolean") set.enabled = b.enabled;
  if (typeof b.label === "string") set.label = b.label;
  if (b.clearCooldown === true) {
    set.cooldownUntil = null;
    set.failCount = 0;
  }
  if (Object.keys(set).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  await db.update(llmKeys).set(set).where(eq(llmKeys.id, params.id));
  return NextResponse.json({ ok: true });
}

// DELETE — remove a key.
export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  await db.delete(llmKeys).where(eq(llmKeys.id, params.id));
  return NextResponse.json({ ok: true });
}
