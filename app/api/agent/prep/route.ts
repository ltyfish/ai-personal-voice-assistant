import { NextRequest, NextResponse } from "next/server";
import { prepareTurn } from "@/lib/agent";
import { readOllamaContextSplit, writeToolSchema, syncMemoryFile, syncMemoryFileToCloud, syncBehaviorFile } from "@/lib/ollama-context";

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
    // Push local vault edits to the cloud first (memory.md/behavior.md → DB), then
    // mirror normalized memory back to memory.md (DB → file) before injecting it.
    await Promise.all([syncMemoryFileToCloud(), syncBehaviorFile()]);
    await syncMemoryFile();
    // STATIC local context (behavior + about-me) goes on TOP of the system prompt so
    // it sits in the cacheable head with the tool schema; VOLATILE context (recent
    // activity) goes at the END of the volatile tail so it doesn't poison the cache.
    const { staticPart, volatilePart } = readOllamaContextSplit();
    if (staticPart) prep.system = `${staticPart}\n\n${prep.system}`;
    if (volatilePart) prep.context = [prep.context, volatilePart].filter(Boolean).join("\n\n");
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
