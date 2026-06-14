import { NextRequest, NextResponse } from "next/server";
import { prepareTurn } from "@/lib/agent";
import { readOllamaContext, writeToolSchema, syncMemoryFile, syncBehaviorFile } from "@/lib/ollama-context";

export const runtime = "nodejs";
export const maxDuration = 30;

// Hands the CLIENT everything it needs to run a turn against a LOCAL model: the
// routed system prompt + tool defs (same routing the cloud loop uses). The
// browser then drives the bridge's Ollama and posts each tool call back to
// /api/agent/tool. Vercel can't reach the bridge, so the loop must live client-
// side; this endpoint just provides the server-built prompt/tools/snapshot.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const text = String(body.text || "").trim();
    if (!text) return NextResponse.json({ error: "no text" }, { status: 400 });
    const prep = await prepareTurn(text, {
      userProfile: String(body.userProfile || "").trim(),
      useSnapshot: body.useSnapshot !== false,
      // Local turns get the full toolset by default; when the deck's tool picker
      // sends an explicit list, only those tools enter the schema.
      allTools: body.allTools === true,
      enabledTools: Array.isArray(body.enabledTools)
        ? body.enabledTools.map((t: unknown) => String(t))
        : undefined,
    });
    // Mirror the "about me" memory (cloud DB) into memory.md first, then inject
    // the local assistant's soul + memory + recent activity (only the local server
    // can read these files). Prepended so persona+memory frame the whole turn.
    // Mirror "about me" (DB→file) and push the vault's behavior.md (file→DB) so the
    // cloud path reads the SAME rules. Both best-effort; run concurrently.
    await Promise.all([syncMemoryFile(), syncBehaviorFile()]);
    const ctx = readOllamaContext();
    if (ctx) prep.system = `${ctx}\n\n${prep.system}`;
    // Expose the live tool schema in Obsidian: exactly the tools sent this turn
    // are flagged enabled, so unchecking a group is visibly reflected.
    try {
      writeToolSchema(prep.tools.map((t: any) => t?.function?.name).filter(Boolean));
    } catch {
      /* best-effort */
    }
    return NextResponse.json(prep);
  } catch (err: any) {
    console.error("/api/agent/prep error", err);
    return NextResponse.json({ error: err?.message || "prep failed" }, { status: 500 });
  }
}
