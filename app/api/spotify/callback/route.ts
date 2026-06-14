import { NextRequest, NextResponse } from "next/server";
import { exchangeCode } from "@/lib/spotify";

export const runtime = "nodejs";

// Spotify redirects here after consent. Exchange the code for tokens and store
// the refresh token, then show a simple confirmation.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    return new NextResponse(`Spotify authorization failed: ${error}`, {
      status: 400,
    });
  }
  if (!code) {
    return new NextResponse("Missing authorization code.", { status: 400 });
  }
  try {
    await exchangeCode(code);
    return new NextResponse(
      "✅ Spotify connected. You can close this tab and say “Jarvis, play …”.",
      { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  } catch (err: any) {
    return new NextResponse(
      `Failed to connect Spotify: ${err?.message || "unknown error"}`,
      { status: 500 }
    );
  }
}
