import { NextRequest, NextResponse } from "next/server";
import { updateProject, deleteProject } from "@/lib/pipeline";

export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const patch: any = {};
    if (typeof body.phase === "string") patch.phase = body.phase;
    if (typeof body.prompt === "string") patch.prompt = body.prompt;
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.workdir === "string") patch.workdir = body.workdir;
    if (typeof body.iteration === "number") patch.iteration = body.iteration;
    if (typeof body.planDone === "boolean") patch.planDone = body.planDone;
    if (typeof body.execDone === "boolean") patch.execDone = body.execDone;
    const project = await updateProject(id, patch);
    if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });
    return NextResponse.json({ project });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    return NextResponse.json({ ok: await deleteProject(id) });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "failed" }, { status: 500 });
  }
}
