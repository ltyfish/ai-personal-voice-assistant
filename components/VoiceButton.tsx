"use client";

import { useRef, useState } from "react";

type Status = "idle" | "recording" | "thinking";

export default function VoiceButton({ onDone }: { onDone: () => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  function speak(text: string) {
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.05;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } catch {
      /* TTS not available — ignore */
    }
  }

  async function startRecording() {
    if (status !== "idle") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void sendAudio(new Blob(chunksRef.current, { type: "audio/webm" }));
      };
      recorderRef.current = rec;
      rec.start();
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
      const form = new FormData();
      form.append("audio", blob, "speech.webm");
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
