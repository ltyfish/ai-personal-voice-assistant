import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, tasks } from "@/db";

export const runtime = "nodejs";

export async function GET() {
  const rows = await db.select().from(tasks).orderBy(asc(tasks.dueDate));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  const [row] = await db
    .insert(tasks)
    .values({
      title: b.title,
      notes: b.notes ?? null,
      priority: b.priority ?? "medium",
      dueDate: b.dueDate ? new Date(b.dueDate) : null,
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
