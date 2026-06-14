import { NextRequest, NextResponse } from "next/server";
import { listProjects, createProject } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ projects: listProjects() });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "failed", projects: [] }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    const project = createProject({
      name,
      prompt: String(body.prompt || ""),
      workdir: String(body.workdir || ""),
    });
    return NextResponse.json({ project });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "failed" }, { status: 500 });
  }
}
