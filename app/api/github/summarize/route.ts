import { NextRequest, NextResponse } from "next/server";
import { summarizePr } from "@/lib/github";

export const runtime = "nodejs";
export const maxDuration = 60;

// POST { owner, repo, number, mode } — summarize or review a PR using the
// rotating model router. mode = "summary" | "review".
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  const owner = String(b?.owner || "").trim();
  const repo = String(b?.repo || "").trim();
  const number = Number(b?.number);
  const mode = b?.mode === "review" ? "review" : "summary";
  if (!owner || !repo || !Number.isInteger(number)) {
    return NextResponse.json({ error: "owner, repo and a numeric PR number are required." }, { status: 400 });
  }
  const r = await summarizePr(owner, repo, number, mode);
  if (!r.ok) return NextResponse.json({ error: r.error }, { status: r.status });
  return NextResponse.json({ text: r.data.text, title: r.data.title, mode });
}
