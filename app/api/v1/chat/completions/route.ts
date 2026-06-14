import { NextRequest, NextResponse } from "next/server";
import { routeChatCompletion } from "@/lib/llm-router";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generations can run long; allow more than the default. (Vercel hobby caps
// this lower — see note in DECISIONS.)
export const maxDuration = 300;

// OpenAI-compatible rotating proxy: POST /api/v1/chat/completions (also exposed
// at /v1/chat/completions via a rewrite in next.config.mjs). Point any OpenAI
// client — including Jarvis's own model layer — at this base URL. The `model`
// field selects the provider: "<platform>/<model-id>".
//
// If LLM_PROXY_KEY is set, callers must send `Authorization: Bearer <that key>`
// (this endpoint is public on Vercel, so set it in production).
export async function POST(req: NextRequest) {
  const required = process.env.LLM_PROXY_KEY;
  if (required) {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token !== required) {
      return NextResponse.json(
        { error: { message: "Unauthorized", type: "invalid_request_error" } },
        { status: 401 },
      );
    }
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error" } },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof routeChatCompletion>>;
  try {
    result = await routeChatCompletion(body);
  } catch (e: any) {
    // An unhandled throw here (e.g. the DB query for keys/config failing) would
    // otherwise surface to the caller as an opaque HTTP 500 with no body. Log it
    // and return the real reason so Hermes shows something actionable.
    console.error("[llm-router] routing threw:", e);
    return NextResponse.json(
      { error: { message: `router error: ${e?.message ?? e}`, type: "rotation_error" } },
      { status: 502 },
    );
  }
  if (!result.ok) {
    return NextResponse.json(
      { error: { message: result.error, type: "rotation_error" } },
      { status: result.status },
    );
  }

  // Pass the upstream response straight through — status, body (streamed SSE or
  // JSON), and content-type — so the client sees a normal OpenAI response.
  const upstream = result.response;
  const headers = new Headers();
  const ct = upstream.headers.get("content-type");
  if (ct) headers.set("content-type", ct);
  return new Response(upstream.body, { status: upstream.status, headers });
}
