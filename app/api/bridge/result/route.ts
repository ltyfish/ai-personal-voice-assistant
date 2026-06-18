import { NextResponse } from "next/server";
import { relayAuthorized, completeCommand, getCommand } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/bridge/result — the laptop bridge reports the outcome of a command.
export async function POST(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = await req.json().catch(() => ({}));
  if (typeof body.id !== "string") {
    return NextResponse.json({ ok: false, error: "missing id" }, { status: 400 });
  }
  const stored = await completeCommand(body.id, {
    ok: !!body.ok,
    status: typeof body.status === "number" ? body.status : body.ok ? 200 : 500,
    data: body.data ?? null,
  });
  return NextResponse.json({ ok: stored });
}

// GET /api/bridge/result?id=… — the phone polls for a command's outcome.
// status: "queued" | "running" → still pending; "done" → result present.
export async function GET(req: Request) {
  if (!relayAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const id = new URL(req.url).searchParams.get("id") || "";
  const cmd = await getCommand(id);
  if (!cmd) return NextResponse.json({ ok: true, found: false });
  return NextResponse.json({
    ok: true,
    found: true,
    status: cmd.status,
    result: cmd.status === "done" ? cmd.result : null,
  });
}
