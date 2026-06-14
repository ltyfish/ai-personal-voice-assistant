import { NextRequest, NextResponse } from "next/server";
import { appendProjectMemory, readProjectMemory } from "@/lib/coding";

export const runtime = "nodejs";
export const maxDuration = 30;

// Per-project coding memory.md. GET ?id= returns the file; POST appends an entry.
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  return NextResponse.json({ memory: readProjectMemory(id) });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "");
    const entry = String(body.entry || "");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    appendProjectMemory(id, entry);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "memory failed" }, { status: 500 });
  }
}
