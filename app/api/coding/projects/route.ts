import { NextRequest, NextResponse } from "next/server";
import { listProjects, createProject } from "@/lib/coding";

export const runtime = "nodejs";
export const maxDuration = 30;

// Coding-mode projects (local-only, stored on disk under the Ollama dir).
// GET  → list all projects.
// POST → create one { name, model, task, workdir }.
export async function GET() {
  try {
    return NextResponse.json({ projects: listProjects() });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "list failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
    // workdir is optional — createProject defaults it to a per-project workspace.
    const project = createProject({
      name,
      model: String(body.model || "").trim(),
      task: String(body.task || "").trim(),
      workdir: String(body.workdir || "").trim(),
    });
    return NextResponse.json({ project });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "create failed" }, { status: 500 });
  }
}
