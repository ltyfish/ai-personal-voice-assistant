import Groq from "groq-sdk";

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is not set. Copy .env.local.example to .env.local.");
}

export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Default cheap/fast model for normal commands. Override per-call if needed.
export const DEFAULT_MODEL = "llama-3.1-8b-instant";
export const STT_MODEL = "whisper-large-v3-turbo";
