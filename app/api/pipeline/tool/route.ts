import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/pipeline";
import { runCodingFileTool } from "@/lib/coding";

export const runtime = "nodejs";

// Execute one workdir-scoped file tool for a pipeline project. Reuses the coding
// file-tool runner (scoped to the project's working folder — the safety boundary).
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const project = await getProject(String(body.projectId || ""));
    if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
    const result = runCodingFileTool(project.workdir, String(body.name || ""), body.args || {});
    return NextResponse.json({ result });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "tool failed" }, { status: 500 });
  }
}
