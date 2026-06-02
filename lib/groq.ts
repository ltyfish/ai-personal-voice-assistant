import Groq from "groq-sdk";

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is not set. Copy .env.local.example to .env.local.");
}

export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// llama-3.3-70b is far more reliable at tool calling than 8b-instant
// (the 8b model frequently emits malformed function-call syntax).
export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// Tried in order. Each model has its OWN per-day token bucket on Groq's free
// tier, so falling through on a 429 roughly multiplies daily capacity.
// gpt-oss-20b is a solid tool-caller; 8b-instant is the last-resort fallback.
export const FALLBACK_MODELS = [
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-20b",
  "llama-3.1-8b-instant",
];
export const STT_MODEL = "whisper-large-v3-turbo";
