import { NextRequest, NextResponse } from "next/server";
import { writeToolSchema } from "@/lib/ollama-context";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const enabledTools = Array.isArray(body.enabledTools)
      ? body.enabledTools.map((t: unknown) => String(t))
      : [];
    writeToolSchema(enabledTools);
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "failed to write tool schema" },
      { status: 500 }
    );
  }
}
