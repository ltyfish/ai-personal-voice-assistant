import { NextRequest, NextResponse } from "next/server";
import { getProject } from "@/lib/pipeline";
import { routeChatCompletion } from "@/lib/llm-router";

export const runtime = "nodejs";
export const maxDuration = 30;

// Smart execution routing: rate a pipeline task easy | medium | hard with ONE
// cheap rotated call, so the execution phase can start at the matching model
// tier (lib/pipeline-agent.ts orderChainForDifficulty). Cheap by design — a
// few tokens out. Any failure falls back to "hard" (use the strongest models),
// so a classifier hiccup never weakens a run.
const SYSTEM =
  "You rate software tasks by implementation difficulty for an autonomous coding agent. " +
  "Reply with EXACTLY one lowercase word and nothing else: easy, medium, or hard. " +
  "easy = a small, localized change (a tweak, a single function, copy/text, one file). " +
  "medium = a feature touching a few files, or moderate logic. " +
  "hard = new architecture, multi-file features, integrations, migrations, auth, or anything subtle.";

function parseDifficulty(text: string): "easy" | "medium" | "hard" {
  const t = (text || "").toLowerCase();
  if (/\bhard\b/.test(t)) return "hard";
  if (/\beasy\b/.test(t)) return "easy";
  if (/\bmedium\b/.test(t)) return "medium";
  return "hard";
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = String(body.id || "");
    const project = await getProject(id);
    if (!project) return NextResponse.json({ error: "unknown project" }, { status: 404 });

    const prompt = (project.prompt || "").slice(0, 2000);
    const result = await routeChatCompletion({
      model: "auto",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Rate this task:\n${prompt}` },
      ],
      temperature: 0,
      max_tokens: 4,
    });
    if (!result.ok) {
      // No model available — default to the strongest tier.
      return NextResponse.json({ difficulty: "hard", note: result.error });
    }
    const json = await result.response.json().catch(() => ({}));
    const text = json?.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ difficulty: parseDifficulty(String(text)) });
  } catch (err: any) {
    return NextResponse.json({ difficulty: "hard", note: err?.message || "classify failed" });
  }
}
