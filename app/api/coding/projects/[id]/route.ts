import { NextRequest, NextResponse } from "next/server";
import { getProject, updateProject, deleteProject } from "@/lib/coding";

export const runtime = "nodejs";
export const maxDuration = 30;

// One coding project: GET it, PATCH (status/task/model/name/workdir), or DELETE.
export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project });
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, string> = {};
  for (const k of ["name", "model", "task", "workdir", "status"] as const) {
    if (typeof body[k] === "string") patch[k] = body[k];
  }
  const project = updateProject(id, patch as any);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ project });
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  const { id } = params;
  const ok = deleteProject(id);
  return NextResponse.json({ ok });
}
