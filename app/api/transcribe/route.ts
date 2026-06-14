import { NextRequest, NextResponse } from "next/server";
import { toFile } from "groq-sdk";
import { groq, STT_MODEL, sniffAudio } from "@/lib/groq";

export const runtime = "nodejs";
export const maxDuration = 15;

// Speech-to-text only (no agent). Used by the spoken yes/no confirmation for
// local actions, so we don't run the whole tool-calling agent just to hear
// "yes". Returns { transcript }.
export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const audio = form.get("audio");
    if (!(audio instanceof Blob)) {
      return NextResponse.json({ error: "no audio provided" }, { status: 400 });
    }
    if (audio.size < 2000) {
      return NextResponse.json({ transcript: "" });
    }
    const bytes = Buffer.from(await audio.arrayBuffer());
    // Label by the real container (the client hardcodes "confirm.webm" even when
    // it recorded mp4/ogg), so Groq decodes it instead of 400-ing.
    const { name, type } = sniffAudio(bytes, audio.type);
    const file = await toFile(bytes, name, { type });
    const transcription = await groq.audio.transcriptions.create({
      file,
      model: STT_MODEL,
      language: "en",
    });
    return NextResponse.json({ transcript: transcription.text.trim() });
  } catch (err: any) {
    // Undecodable clip — return empty so the confirm flow just treats it as "no
    // answer" rather than throwing.
    if (/could not process file|valid media file/i.test(err?.message || "")) {
      console.warn("/api/transcribe: Groq rejected the audio clip");
      return NextResponse.json({ transcript: "" });
    }
    console.error("/api/transcribe error", err);
    return NextResponse.json(
      { error: err?.message || "transcription failed" },
      { status: 500 }
    );
  }
}
