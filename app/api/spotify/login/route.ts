import { NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { authorizeUrl } from "@/lib/spotify";

export const runtime = "nodejs";

// Visit once to connect your Spotify account. Redirects to Spotify's consent
// screen; Spotify then calls back to /api/spotify/callback.
export async function GET() {
  try {
    const state = randomBytes(8).toString("hex");
    return NextResponse.redirect(authorizeUrl(state));
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Spotify not configured" },
      { status: 500 }
    );
  }
}
