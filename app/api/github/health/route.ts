import { NextResponse } from "next/server";
import { listReposHealth, hasToken } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — per-repo health (default-branch CI, last activity, open issues) for every
// configured repo. PR-free signals, useful even when nothing is open.
export async function GET() {
  if (!(await hasToken())) {
    return NextResponse.json({ repos: [], needsToken: true });
  }
  const repos = await listReposHealth();
  return NextResponse.json({ repos });
}
