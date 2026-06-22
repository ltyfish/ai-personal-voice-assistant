import { NextRequest, NextResponse } from "next/server";
import { summarizeRepo } from "@/lib/github";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST { owner, repo } | { repo: "owner/repo" } — summarize a repository and what
// changed since the last call, via the rotating model router. The "last seen"
// commit is persisted server-side so repeated presses diff against it.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  let owner = String(b?.owner || "").trim();
  let repo = String(b?.repo || "").trim();
  if (!owner && repo.includes("/")) [owner, repo] = repo.split("/");
  if (!owner || !repo) {
    return NextResponse.json({ error: "owner and repo are required (or repo as 'owner/repo')." }, { status: 400 });
  }
  const r = await summarizeRepo(owner, repo);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json(r.data);
}
