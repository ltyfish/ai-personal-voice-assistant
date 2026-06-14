import { NextRequest, NextResponse } from "next/server";
import { appendProjectMemory, readProjectMemory } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") || "";
  return NextResponse.json({ memory: readProjectMemory(id) });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    appendProjectMemory(String(body.id || ""), String(body.entry || ""));
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "failed" }, { status: 500 });
  }
}
