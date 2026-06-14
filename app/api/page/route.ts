import { NextRequest, NextResponse } from "next/server";
import { readPageText } from "@/lib/agent";
import { addGroqUsage } from "@/lib/mail/blobs";

export const runtime = "nodejs";
export const maxDuration = 30;

// Summarize/read page TEXT that the LOCAL BRIDGE already extracted from a real,
// logged-in browser (Phase 2). The server can't reach those pages itself, so the
// browser sends the content here and we phrase the spoken summary/read-back with
// the same model chain the voice agent uses. (Public pages don't need this — the
// read_site tool fetches + summarizes them server-side in one shot.)
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const content = String(body.content || "").trim();
    const title = body.title ? String(body.title) : "";
    const mode = body.mode === "read" ? "read" : "summarize";
    if (!content) {
      return NextResponse.json({ error: "no page content provided" }, { status: 400 });
    }

    const { reply, usage, model } = await readPageText({ content, title, mode });

    if (usage && usage.total > 0) {
      try {
        await addGroqUsage(
          { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total },
          { model }
        );
      } catch (e) {
        console.error("addGroqUsage (page) failed", e);
      }
    }

    return NextResponse.json({ reply, model });
  } catch (err: any) {
    console.error("/api/page error", err);
    return NextResponse.json({ error: err?.message || "page read failed" }, { status: 500 });
  }
}
