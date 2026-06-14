import { NextResponse } from "next/server";
import { syncBehaviorFile } from "@/lib/ollama-context";

export const runtime = "nodejs";

// Push the local vault's behavior.md into the cloud DB so the cloud path reads the
// same persona/rules. Only works on the LOCAL instance (which owns the vault file);
// on the cloud deploy there's no file, so `synced` comes back false and the UI can
// tell the user to run it from their own machine.
export async function POST() {
  try {
    const synced = await syncBehaviorFile();
    return NextResponse.json({ synced });
  } catch (err: any) {
    return NextResponse.json(
      { synced: false, error: err?.message || "sync failed" },
      { status: 500 }
    );
  }
}
