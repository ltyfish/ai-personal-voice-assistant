import { NextRequest, NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, projects } from "@/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db
    .select()
    .from(projects)
    .orderBy(asc(projects.position), asc(projects.seq));
  return NextResponse.json(rows);
}

export async function POST(req: NextRequest) {
  const b = await req.json();
  const [row] = await db
    .insert(projects)
    .values({
      title: b.title,
      improvements: Array.isArray(b.improvements) ? b.improvements : [],
    })
    .returning();
  return NextResponse.json(row, { status: 201 });
}
