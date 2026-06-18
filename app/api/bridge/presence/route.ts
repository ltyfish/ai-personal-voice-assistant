import { NextResponse } from "next/server";
import { relayAuthorized, getPresence } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Consider the laptop online if it heartbeat within this window.
const ONLINE_MS = 15_000;

// GET /api/bridge/presence — the phone asks "is my computer on?". Gated by the
// shared relay secret so presence isn't leaked to anyone with the URL.
export async function GET(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const p = await getPresence();
  const online = !!p && Date.now() - p.lastSeen < ONLINE_MS;
  return NextResponse.json({
    ok: true,
    online,
    home: online ? p?.home ?? "" : "",
    apps: online ? p?.apps ?? [] : [],
    shellEnabled: online ? !!p?.shellEnabled : false,
    lastSeen: p?.lastSeen ?? 0,
  });
}
