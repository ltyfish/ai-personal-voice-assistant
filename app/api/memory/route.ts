import { NextRequest, NextResponse } from "next/server";
import { getMemory, saveMemory } from "@/lib/memory";

export const runtime = "nodejs";

// The user's "about me" memory (logins / startups / notes). Website shortcuts
// have their own endpoint (/api/shortcuts) but are returned here too so the UI
// can render the whole picture. Local config like /api/shortcuts — no secret.
export async function GET() {
  const memory = await getMemory();
  return NextResponse.json({ memory });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const memory = await saveMemory({
      logins: body?.logins,
      startups: body?.startups,
      notes: body?.notes,
    });
    return NextResponse.json({ ok: true, memory });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "failed to save memory";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
