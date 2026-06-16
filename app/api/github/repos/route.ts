import { NextRequest, NextResponse } from "next/server";
import { listConfiguredRepos, addRepo, removeRepo, isValidRepo } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — the configured repo list.
export async function GET() {
  return NextResponse.json({ repos: await listConfiguredRepos() });
}

// POST { owner, repo } | { full: "owner/repo" } — add a repo to the list.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  let owner = String(b?.owner || "").trim();
  let repo = String(b?.repo || "").trim();
  if ((!owner || !repo) && typeof b?.full === "string" && b.full.includes("/")) {
    [owner, repo] = b.full.trim().split("/", 2);
  }
  if (!isValidRepo(owner, repo)) return NextResponse.json({ error: "Invalid owner/repo." }, { status: 400 });
  try {
    return NextResponse.json({ repos: await addRepo(owner, repo) });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Couldn't add repo." }, { status: 400 });
  }
}

// DELETE ?owner=&repo= — remove a repo.
export async function DELETE(req: NextRequest) {
  const url = new URL(req.url);
  const owner = String(url.searchParams.get("owner") || "").trim();
  const repo = String(url.searchParams.get("repo") || "").trim();
  return NextResponse.json({ repos: await removeRepo(owner, repo) });
}
