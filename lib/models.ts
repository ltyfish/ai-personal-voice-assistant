// Central model registry for the voice agent's fallback chain.
//
// Ordered strongest/cheapest-first; the agent tries each in turn, skipping any
// that are disabled (user choice) or exhausted (daily limit hit). Gemini models
// lead — they're free and great tool callers — and fall through to the Groq
// models when their daily quota is spent. This file is PURE DATA (no SDK/db/env
// imports) so the client can import it for labels and ordering.

export type Provider = "groq" | "gemini" | "nvidia";

export interface ModelDef {
  id: string;
  provider: Provider;
  label: string;
  /** per-day token cap (Groq free tier), for the usage UI; optional */
  tpd?: number;
  /** per-day request cap (Gemini free tier), for the usage UI; optional */
  rpd?: number;
  /** "thinking" models that emit chain-of-thought — avoid for the spoken summary */
  reasoning?: boolean;
}

// Best-to-worst free model chain. A bad/retired id is skipped automatically by
// the agent/router, so this list is safe to expand.
export const MODELS: ModelDef[] = [
  { id: "openai/gpt-oss-120b", provider: "groq", label: "GPT-OSS 120B", tpd: 200_000, reasoning: true },
  { id: "meta-llama/llama-4-maverick-17b-128e-instruct", provider: "nvidia", label: "Llama 4 Maverick" },
  { id: "llama-3.3-70b-versatile", provider: "groq", label: "Llama 3.3 70B", tpd: 100_000 },
  { id: "qwen/qwen3-32b", provider: "groq", label: "Qwen3 32B", reasoning: true },
  { id: "gemini-2.5-flash", provider: "gemini", label: "Gemini 2.5 Flash", rpd: 250 },
  { id: "meta-llama/llama-4-scout-17b-16e-instruct", provider: "groq", label: "Llama 4 Scout" },
  { id: "openai/gpt-oss-20b", provider: "groq", label: "GPT-OSS 20B", tpd: 200_000, reasoning: true },
  { id: "gemini-2.5-flash-lite", provider: "gemini", label: "Gemini 2.5 Flash-Lite", rpd: 1000 },
];

export const MODEL_IDS = MODELS.map((m) => m.id);

export function modelById(id: string): ModelDef | undefined {
  return MODELS.find((m) => m.id === id);
}
