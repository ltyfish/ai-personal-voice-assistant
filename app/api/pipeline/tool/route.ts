import { NextRequest, NextResponse } from "next/server";
import { getProject, defaultWorkdir } from "@/lib/pipeline";
import { runCodingFileTool } from "@/lib/coding";

export const runtime = "nodejs";

// Execute one workdir-scoped file tool for a pipeline project. Reuses the coding
// file-tool runner (scoped to the project's working folder — the safety boundary).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const project = await getProject(String(body.projectId || ""));
    if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
    // Blank workdir → the same fallback the bridge uses, so the in-browser (local)
    // path no longer fails file tools while the bridge silently builds elsewhere.
    const workdir = project.workdir?.trim() || defaultWorkdir(project.id);
    const result = runCodingFileTool(workdir, String(body.name || ""), body.args || {});
    return NextResponse.json({ result });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "tool failed" }, { status: 500 });
  }
}
