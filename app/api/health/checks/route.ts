import { NextRequest, NextResponse } from "next/server";
import { listChecks, addCheck, removeCheck, getLastResults } from "@/lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — configured checks + their last cached results.
export async function GET() {
  const [checks, results] = await Promise.all([listChecks(), getLastResults()]);
  return NextResponse.json({ checks, results });
}

// POST { name, url, method?, expectStatus? } — add a check.
export async function POST(req: NextRequest) {
  const b = await req.json().catch(() => ({}));
  try {
    const checks = await addCheck({
      name: String(b?.name || ""),
      url: String(b?.url || ""),
      method: b?.method,
      expectStatus: b?.expectStatus != null ? Number(b.expectStatus) : undefined,
    });
    return NextResponse.json({ checks });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Couldn't add check." }, { status: 400 });
  }
}

// DELETE ?id= — remove a check.
export async function DELETE(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id") || "";
  return NextResponse.json({ checks: await removeCheck(id) });
}
