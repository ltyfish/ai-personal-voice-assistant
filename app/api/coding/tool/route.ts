import { NextRequest, NextResponse } from "next/server";
import { getProject, runCodingFileTool } from "@/lib/coding";

export const runtime = "nodejs";
export const maxDuration = 60;

// Execute a SCOPED coding file tool (read/write/edit/list) for a project. The
// path-scoping gate lives in runCodingFileTool: a path that escapes the project's
// working folder is refused. Only reachable when the Next server runs locally.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const projectId = String(body.projectId || "");
    const name = String(body.name || "");
    const args = body.args && typeof body.args === "object" ? body.args : {};
    const project = getProject(projectId);
    if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
    if (!project.workdir) return NextResponse.json({ result: { ok: false, error: "this project has no working folder set" } });
    const result = runCodingFileTool(project.workdir, name, args);
    return NextResponse.json({ result });
  } catch (err: any) {
    return NextResponse.json({ result: { ok: false, error: err?.message || "tool failed" } });
  }
}
