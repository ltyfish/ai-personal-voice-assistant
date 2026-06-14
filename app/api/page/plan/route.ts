import { NextRequest, NextResponse } from "next/server";
import { planPageAction } from "@/lib/agent";
import { addGroqUsage } from "@/lib/mail/blobs";

export const runtime = "nodejs";
export const maxDuration = 30;

// Single-step page-action planner (Phase 2 clicking). The local bridge snapshots
// the live, logged-in page into a pruned element list and sends it here with the
// user's instruction; we return ONE action ({act, ref, text, say}) for the browser
// to confirm + execute. The browser stays on the user's machine; only the compact
// element list crosses the wire (the token-saver).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const instruction = String(body.instruction || "").trim();
    const tree = String(body.tree || "").trim();
    const title = body.title ? String(body.title) : "";
    if (!instruction) return NextResponse.json({ error: "no instruction" }, { status: 400 });
    if (!tree) return NextResponse.json({ error: "no page elements" }, { status: 400 });

    const { plan, usage, model } = await planPageAction({ instruction, tree, title });

    if (usage && usage.total > 0) {
      try {
        await addGroqUsage(
          { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total },
          { model }
        );
      } catch (e) {
        console.error("addGroqUsage (page/plan) failed", e);
      }
    }

    return NextResponse.json({ plan, model });
  } catch (err: any) {
    console.error("/api/page/plan error", err);
    return NextResponse.json({ error: err?.message || "planning failed" }, { status: 500 });
  }
}
