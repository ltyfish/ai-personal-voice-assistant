import { NextRequest, NextResponse } from "next/server";
import { groq, STT_MODEL } from "@/lib/groq";
import { runAgent } from "@/lib/agent";

export const runtime = "nodejs";
export const maxDuration = 30;

// Accepts either an audio file (multipart) to transcribe + act on,
// or a JSON { text } to skip STT (useful for typed testing).
export async function POST(req: NextRequest) {
  try {
    let userText = "";
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await req.json();
      userText = (body.text || "").trim();
    } else {
      const form = await req.formData();
      const audio = form.get("audio");
      if (!(audio instanceof Blob)) {
        return NextResponse.json({ error: "no audio provided" }, { status: 400 });
      }
      const file = new File([audio], "speech.webm", {
        type: audio.type || "audio/webm",
      });
      const transcription = await groq.audio.transcriptions.create({
        file,
        model: STT_MODEL,
      });
      userText = transcription.text.trim();
    }

    if (!userText) {
      return NextResponse.json(
        { transcript: "", reply: "I didn't catch that.", actions: [] },
        { status: 200 }
      );
    }

    const { reply, actions } = await runAgent(userText);
    return NextResponse.json({ transcript: userText, reply, actions });
  } catch (err: any) {
    console.error("/api/voice error", err);
    return NextResponse.json(
      { error: err?.message || "voice pipeline failed" },
      { status: 500 }
    );
  }
}
