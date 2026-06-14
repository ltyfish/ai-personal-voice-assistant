import { NextRequest, NextResponse } from "next/server";
import { writePhaseDoc } from "@/lib/pipeline";

export const runtime = "nodejs";

// Mirror a finished phase's report (Planning / Execution / Review & Test) into the
// project's vault folder so each is browsable as its own Markdown file in Obsidian.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ok = writePhaseDoc(String(body.id || ""), String(body.phase || ""), String(body.summary || ""));
    return NextResponse.json({ ok });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "failed" }, { status: 500 });
  }
}
