import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db, notes } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db.select().from(notes).orderBy(desc(notes.updatedAt));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  const [row] = await db
    .insert(notes)
    .values({
      title: b.title ?? null,
      body: b.body ?? "",
      date: b.date ? new Date(b.date) : null,
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
