import { NextRequest, NextResponse } from "next/server";
import { getRouterConfig, saveRouterConfig, ROUTER_LIMITS } from "@/lib/router-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — current router knobs plus their slider bounds.
export async function GET() {
  const config = await getRouterConfig();
  return NextResponse.json({ config, limits: ROUTER_LIMITS });
}

// POST — update router knobs; values are clamped server-side.
export async function POST(req: NextRequest) {
  let b: any;
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const config = await saveRouterConfig({
    timeoutMs: b?.timeoutMs,
    cooldownRateLimitMs: b?.cooldownRateLimitMs,
    cooldownClientErrorMs: b?.cooldownClientErrorMs,
  });
  return NextResponse.json({ config, limits: ROUTER_LIMITS });
}
