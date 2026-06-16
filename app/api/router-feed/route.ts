import { NextRequest, NextResponse } from "next/server";
import { clearRouterEvents, getRouterEvents } from "@/lib/router-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/router-feed?since=<lastId> — the live rotation + token feed the
// RouterFeed panel polls. Returns events newer than `since` plus the current
// high-water id to pass back next poll. DB-backed so it works across serverless
// instances (cloud); see lib/router-feed.ts.
export async function GET(req: NextRequest) {
  const sinceRaw = req.nextUrl.searchParams.get("since");
  const since = sinceRaw ? Number(sinceRaw) || 0 : 0;
  return NextResponse.json(await getRouterEvents(since));
}

export async function DELETE() {
  return NextResponse.json(await clearRouterEvents());
}
