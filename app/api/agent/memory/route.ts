import { NextRequest, NextResponse } from "next/server";
import { appendDecision, appendActivity } from "@/lib/ollama-context";
import { recordActivity } from "@/lib/activity";

export const runtime = "nodejs";
export const maxDuration = 30;

// Records a LOCAL turn into the Ollama "soul" files: the WHY (decision.md) and the
// short-term activity log (activity.md, the last few of which are recapped next
// turn). memory.md is NOT touched here — it's the synced "about me" facts, not a
// conversation log. Only meaningful when the server runs on the user's machine
// (local mode); best-effort, never fatal. Called fire-and-forget after each turn.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const user = String(body.user || "");
    const assistant = String(body.assistant || "");
    const reasoning = String(body.reasoning || "");
    const actions = Array.isArray(body.actions) ? body.actions : [];

    appendDecision(reasoning, actions);
    appendActivity(
      user,
      actions.map((a: any) => String(a?.name ?? "")).filter(Boolean),
      assistant
    );
    // Mirror into the unified `activity` DB table so local turns show in the
    // Activity card and feed the same short-term recall as cloud turns.
    await recordActivity({
      source: "local",
      user,
      reply: assistant,
      model: String(body.model || "local"),
      actions: actions.map((a: any) => ({ name: String(a?.name ?? ""), args: a?.args })),
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "memory failed" });
  }
}
