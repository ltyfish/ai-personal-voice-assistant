"use client";

import { useEffect, useRef, useState } from "react";

type Status = "idle" | "recording" | "thinking";

export default function VoiceButton({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Trigger voice list loading early so the first reply isn't silent.
  useEffect(() => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.getVoices();
    const handler = () => window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", handler);
    return () =>
      window.speechSynthesis.removeEventListener("voiceschanged", handler);
  }, []);

  function speak(text: string) {
    try {
      const synth = window.speechSynthesis;
      // Recover from the browser getting stuck in a paused/speaking state.
      synth.resume();
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-US";
      u.rate = 1.05;
      const enVoice = synth
        .getVoices()
        .find((v) => v.lang?.toLowerCase().startsWith("en"));
      if (enVoice) u.voice = enVoice;
      synth.speak(u);
      // Chrome bug: synthesis silently pauses on longer clips — nudge it.
      setTimeout(() => synth.resume(), 200);
    } catch {
      /* TTS not available — ignore */
    }
  }

  function pickMimeType() {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/mp4",
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  async function startRecording() {
    if (status !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        },
      });
      const mimeType = pickMimeType();
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, {
          type: rec.mimeType || "audio/webm",
        });
        // Too small => almost certainly an empty/aborted recording.
        if (blob.size < 1200) {
          setStatus("idle");
          setReply("That was too short — hold the button while you speak.");
          return;
        }
        void sendAudio(blob);
      };
      recorderRef.current = rec;
      // Timeslice => guarantees chunks are flushed even for short clips.
      rec.start(250);
      setStatus("recording");
      setTranscript("");
      setReply("");
    } catch (err) {
      setReply("Microphone access denied.");
    }
  }

  function stopRecording() {
    if (status !== "recording") return;
    recorderRef.current?.stop();
    setStatus("thinking");
  }

  async function sendAudio(blob: Blob) {
    try {
      const ext = blob.type.includes("mp4")
        ? "mp4"
        : blob.type.includes("ogg")
        ? "ogg"
        : "webm";
      const form = new FormData();
      form.append("audio", blob, `speech.${ext}`);
      const res = await fetch("/api/voice", { method: "POST", body: form });
      const data = await res.json();
      setTranscript(data.transcript || "");
      setReply(data.reply || data.error || "");
      if (data.reply) speak(data.reply);
      onDone();
    } catch {
      setReply("Something went wrong.");
    } finally {
      setStatus("idle");
    }
  }

  const label =
    status === "recording"
      ? "Listening… release to send"
      : status === "thinking"
      ? "Thinking…"
      : "Hold to talk";

  return (
    <div className="flex flex-col items-center gap-3">
      <button
        onMouseDown={startRecording}
        onMouseUp={stopRecording}
        onMouseLeave={stopRecording}
        onTouchStart={(e) => {
          e.preventDefault();
          startRecording();
        }}
        onTouchEnd={(e) => {
          e.preventDefault();
          stopRecording();
        }}
        disabled={status === "thinking"}
        className={`h-24 w-24 select-none rounded-full text-lg font-semibold shadow-lg transition-transform active:scale-95 ${
          status === "recording"
            ? "animate-pulse bg-red-500"
            : status === "thinking"
            ? "bg-amber-500"
            : "bg-indigo-600 hover:bg-indigo-500"
        }`}
      >
        🎤
      </button>
      <p className="text-sm text-neutral-400">{label}</p>
      {transcript && (
        <p className="max-w-md text-center text-sm text-neutral-300">
          <span className="text-neutral-500">You:</span> {transcript}
        </p>
      )}
      {reply && (
        <p className="max-w-md text-center text-sm text-indigo-300">
          <span className="text-neutral-500">AI:</span> {reply}
        </p>
      )}
    </div>
  );
}
