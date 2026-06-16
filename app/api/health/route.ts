import { NextResponse } from "next/server";
import { getSelfHealth } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/health — this app's own health, for uptime monitors and JARVIS.
// 200 when healthy, 503 when a required dependency (db / required env) is down.
export async function GET() {
  const health = await getSelfHealth();
  return NextResponse.json(health, { status: health.ok ? 200 : 503 });
}
