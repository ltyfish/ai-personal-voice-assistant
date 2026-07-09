import { NextRequest, NextResponse } from "next/server";
import { toFile } from "groq-sdk";
import { groq, FALLBACK_MODELS, classifyRateLimit, sniffAudio } from "@/lib/groq";
import { runAgent, warmModels } from "@/lib/agent";
import { recordActivity } from "@/lib/activity";
import { addGroqUsage } from "@/lib/mail/blobs";
import { selectSttModel } from "@/lib/stt-model";

export const runtime = "nodejs";
// 60s (Vercel's Hobby ceiling) gives the agent room to fail over across a few
// models — each upstream call is capped at 15s by the router (router-config) —
// instead of timing out at 30s with a 504.
export const maxDuration = 60;

// Accepts either an audio file (multipart) to transcribe + act on,
// or a JSON { text } to skip STT (useful for typed testing).
export async function POST(req: NextRequest) {
  const requestStartedAt = performance.now();
  let sttMs = 0;
  let agentMs = 0;
  try {
    let userText = "";
    let userProfile = ""; // user's Windows home dir, for run_shell paths
    let maxWords = 0; // spoken-reply word cap (0 => agent default)
    let useSnapshot = true; // attach the current-data snapshot (off => fewer tokens)
    let browserOpen = false; // a controlled browser is open → de-keyword page instructions
    let enabledTools: string[] | undefined; // client tool picker allow-list
    let bridgeAvailable = false; // is the user's computer connected this turn?
    let sttMode = "default";
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      const body = await req.json();
      // Warm-up ping (sent on page load and after a model rotation): wake this
      // serverless function + prime the LLM prompt cache so the first real
      // request is fast. Returns immediately, runs no STT/agent.
      if (body.warm === true) {
        const { warmed } = await warmModels();
        return NextResponse.json({ warmed });
      }
      userText = (body.text || "").trim();
      userProfile = (body.userProfile || "").trim();
      maxWords = Number(body.maxWords) || 0;
      if (body.useSnapshot === false) useSnapshot = false;
      if (body.browserOpen === true) browserOpen = true;
      enabledTools = Array.isArray(body.enabledTools)
        ? body.enabledTools.map((t: unknown) => String(t))
        : undefined;
      bridgeAvailable = body.bridgeAvailable === true;
    } else {
      const form = await req.formData();
      const audio = form.get("audio");
      userProfile = String(form.get("userProfile") || "").trim();
      maxWords = Number(form.get("maxWords")) || 0;
      if (String(form.get("useSnapshot")) === "false") useSnapshot = false;
      if (String(form.get("browserOpen")) === "true") browserOpen = true;
      const rawEnabled = String(form.get("enabledTools") || "");
      if (rawEnabled) {
        try {
          const parsed = JSON.parse(rawEnabled);
          if (Array.isArray(parsed)) enabledTools = parsed.map((t: unknown) => String(t));
        } catch {
          enabledTools = undefined;
        }
      }
      bridgeAvailable = String(form.get("bridgeAvailable")) === "true";
      sttMode = String(form.get("sttMode") || "default");
      if (!(audio instanceof Blob)) {
        return NextResponse.json({ error: "no audio provided" }, { status: 400 });
      }
      // Reject near-empty clips early — a header-only webm is "valid" by size
      // but Groq can't decode it, returning a misleading 400.
      if (audio.size < 2000) {
        return NextResponse.json(
          { transcript: "", reply: "I didn't catch that.", actions: [] },
          { status: 200 }
        );
      }
      // Read the bytes ourselves and use the SDK's toFile helper. Re-wrapping
      // the multipart Blob in a Node File and passing it straight through can
      // serialize an upload with no usable body, which Groq rejects with
      // "could not process file - is it a valid media file?".
      const bytes = Buffer.from(await audio.arrayBuffer());
      // Trust the bytes, not the filename/blob.type: if the browser actually
      // recorded mp4/ogg but we labelled it .webm, Groq picks the wrong decoder
      // and 400s. Detect the real container from the magic bytes.
      const { name, type } = sniffAudio(bytes, audio.type);
      console.log(
        `[voice] stt: ${audio.size}B type=${audio.type || "?"} -> ${name} (${type}) magic=${bytes
          .subarray(0, 12)
          .toString("hex")}`
      );
      const file = await toFile(bytes, name, { type });
      const sttStartedAt = performance.now();
      const transcription = await groq.audio.transcriptions.create({
        file,
        model: selectSttModel(sttMode),
        language: "en", // force English so it doesn't mis-detect other languages
        temperature: 0, // deterministic, most-likely transcription
      });
      sttMs = Math.round(performance.now() - sttStartedAt);
      userText = transcription.text.trim();
    }

    if (!userText) {
      return NextResponse.json(
        { transcript: "", reply: "I didn't catch that.", actions: [] },
        { status: 200 }
      );
    }

    const agentStartedAt = performance.now();
    const { reply, actions, model, models, exhausted, usage, limits, routed, routing } =
      await runAgent(userText, { userProfile, maxWords, useSnapshot, enabledTools, bridgeAvailable });
    agentMs = Math.round(performance.now() - agentStartedAt);

    // Persist this cloud turn to the activity log: powers both short-term recall
    // (injected as a volatile tail block on the next turn) and the Activity card.
    // Awaited because Vercel may freeze the function after the response.
    await recordActivity({
      source: "cloud",
      user: userText,
      reply,
      model,
      actions: Array.isArray(actions) ? actions.map((a: any) => ({ name: a?.name, args: a?.args })) : [],
    });

    // Record into the shared Groq usage pool used by model status/routing.
    if (usage && usage.total > 0) {
      try {
        await addGroqUsage(
          {
            prompt_tokens: usage.prompt,
            completion_tokens: usage.completion,
            total_tokens: usage.total,
          },
          { model, limits }
        );
      } catch (e) {
        console.error("addGroqUsage (voice) failed", e);
      }
    }

    return NextResponse.json({
      transcript: userText,
      reply,
      actions,
      model,
      models,
      exhausted,
      usage,
      routed,
      routing,
      timings: {
        sttMs,
        agentMs,
        totalMs: Math.round(performance.now() - requestStartedAt),
      },
    });
  } catch (err: any) {
    const is429 =
      err?.status === 429 || /rate limit|quota/i.test(err?.message || "");
    // Expected rate limits are noise — log one line, not a full stack trace.
    if (is429) console.warn("/api/voice rate-limited:", classifyRateLimit(err).scope);
    else console.error("/api/voice error", err);

    // Rate limited on every model. Distinguish the real daily quota (out of our
    // control) from a transient per-minute burst (just retry in a moment), and
    // don't cross out all models for a transient limit.
    if (is429) {
      const { scope } = classifyRateLimit(err);
      const daily = scope === "day";
      return NextResponse.json({
        transcript: "",
        reply: daily
          ? "I've hit my daily AI usage limit, which is out of my control. Please try again later."
          : "I'm getting rate-limited right now — give me a few seconds and try again.",
        actions: [],
        rateLimited: true,
        models: FALLBACK_MODELS,
        exhausted: daily ? FALLBACK_MODELS : [],
      });
    }

    // Groq couldn't decode the audio (bad/short/empty clip). Not a server fault
    // — answer gracefully and prompt a retry instead of a 500.
    if (/could not process file|valid media file/i.test(err?.message || "")) {
      console.warn("/api/voice: Groq rejected the audio clip");
      return NextResponse.json({
        transcript: "",
        reply: "I couldn't make out that audio — say “Jarvis” and try again.",
        actions: [],
      });
    }

    // Other errors (schema/param/etc) stay raw on purpose, for debugging.
    return NextResponse.json(
      { error: err?.message || "voice pipeline failed" },
      { status: 500 }
    );
  }
}
