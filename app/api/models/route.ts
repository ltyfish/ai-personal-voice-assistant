import { NextRequest, NextResponse } from "next/server";
import { computeModelStatus } from "@/lib/model-status";
import { saveModelConfig } from "@/lib/model-config";
import { clearModelDailyLimit } from "@/lib/mail/blobs";

export const runtime = "nodejs";

// Live model status + selection for the JARVIS deck. No DASHBOARD_SECRET — it's
// local assistant config like /api/tasks and /api/keywords.
export async function GET() {
  const status = await computeModelStatus();
  return NextResponse.json(status);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    // `disabled` (when present) sets the enable/disable selection; `recheck` is a
    // list of models whose daily-quota record to clear so they get re-probed.
    // They're independent so the bridge can push either without clobbering the
    // other (a recheck-only push must not wipe the disabled set).
    if (Array.isArray(body?.disabled)) {
      await saveModelConfig({ disabled: body.disabled });
    }
    if (Array.isArray(body?.recheck) && body.recheck.length) {
      await clearModelDailyLimit(body.recheck);
    }
    // Return the fresh status so the UI updates which model is now active.
    const status = await computeModelStatus();
    return NextResponse.json({ ok: true, ...status });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "failed to save model selection" },
      { status: 500 }
    );
  }
}
