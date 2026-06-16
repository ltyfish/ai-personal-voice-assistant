import { NextResponse } from "next/server";
import { listAllOpenPrs, hasToken } from "@/lib/github";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — every open PR across the configured repos, each with CI status.
export async function GET() {
  if (!(await hasToken())) {
    return NextResponse.json({ prs: [], errors: [], needsToken: true });
  }
  const { prs, errors } = await listAllOpenPrs();
  return NextResponse.json({ prs, errors });
}
