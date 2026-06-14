import { NextRequest, NextResponse } from "next/server";
import { runTool, toolDefs } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 30;

const KNOWN = new Set(toolDefs.map((d) => d.function.name));

// Execute ONE tool call for the client-driven local loop. The local model (run
// in the browser via the bridge) emits tool calls; the browser posts each here
// so it runs against the cloud DB with the same runTool the cloud loop uses.
// Only known tool names are allowed (no arbitrary execution).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const name = String(body.name || "");
    if (!KNOWN.has(name)) {
      return NextResponse.json({ error: `unknown tool "${name}"` }, { status: 400 });
    }
    let args = body.args;
    if (args === null || typeof args !== "object") args = {};
    const result = await runTool(name, args);
    return NextResponse.json({ result });
  } catch (err: any) {
    console.error("/api/agent/tool error", err);
    return NextResponse.json({ error: err?.message || "tool failed" }, { status: 500 });
  }
}
