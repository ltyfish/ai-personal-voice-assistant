import { NextRequest, NextResponse } from "next/server";
import { getShortcuts, saveShortcuts } from "@/lib/shortcuts";
import { syncMemoryFile } from "@/lib/ollama-context";

export const runtime = "nodejs";

// User-defined website shortcuts (keyword → URL). Local config like /api/keywords,
// so no DASHBOARD_SECRET.
export async function GET() {
  const shortcuts = await getShortcuts();
  return NextResponse.json({ shortcuts });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const shortcuts = await saveShortcuts(body?.shortcuts ?? []);
    // Mirror website shortcuts into memory.md (Obsidian vault) immediately.
    // Best-effort: only writes where the local fs is reachable.
    await syncMemoryFile();
    return NextResponse.json({ ok: true, shortcuts });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "failed to save shortcuts";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
