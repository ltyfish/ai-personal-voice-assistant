import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, events } from "@/db";

export const runtime = "nodejs";

export async function GET() {
  const rows = await db.select().from(events).orderBy(asc(events.startTime));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  const [row] = await db
    .insert(events)
    .values({
      title: b.title,
      location: b.location ?? null,
      startTime: new Date(b.startTime),
      endTime: new Date(b.endTime),
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
