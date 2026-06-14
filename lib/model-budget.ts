// Fallback free-tier DAILY token budgets (TPD) per provider/model.
//
// The real cap is whatever the freellmapi/bridge catalog records on each
// llm_models row (tpdLimit) — that always wins. This table only fills the gap
// for models whose catalog row has no tpdLimit, so the LLM-Keys + Pipeline
// budget bars still show a sensible "remaining / daily budget" instead of
// nothing. Numbers are per SINGLE key; the caller multiplies by the number of
// keys a provider has (more keys = more combined free quota).
//
// Sources (June 2026 free-tier docs):
//   • Groq publishes explicit per-model TPD (e.g. llama-3.3-70b = 100K,
//     gpt-oss-120b = 200K). https://tokenmix.ai/blog/groq-free-tier-limits-2026
//   • Gemini / OpenRouter / GitHub Models are REQUEST-limited (RPD), not token-
//     limited, so their values here are token-equivalent estimates (RPD × a
//     typical tokens-per-request), not hard caps.
// Treat anything not from the catalog as an estimate — easy to tune later.

// Per-model overrides take priority over the provider default. Keys are the full
// "<platform>/<model>" router id (lower-cased on lookup).
const MODEL_TPD: Record<string, number> = {
  // Groq — published per-model daily token limits (free plan).
  "groq/llama-3.3-70b-versatile": 100_000,
  "groq/openai/gpt-oss-120b": 200_000,
  "groq/openai/gpt-oss-20b": 200_000,
  "groq/meta-llama/llama-4-scout-17b-16e-instruct": 100_000,
  "groq/meta-llama/llama-4-maverick-17b-128e-instruct": 100_000,
  "groq/qwen/qwen3-32b": 100_000,
  "groq/gemma2-9b-it": 150_000,
  "groq/deepseek-r1-distill-llama-70b": 100_000,
  "nvidia/meta-llama/llama-4-maverick-17b-128e-instruct": 1_000_000,
};

// Provider-level default daily token budget (per key) when the model isn't in
// the override table and the catalog has no tpdLimit.
const PLATFORM_TPD: Record<string, number> = {
  groq: 100_000,        // typical free-plan per-model TPD
  google: 1_000_000,    // ~250 RPD free, large TPM — token-equivalent estimate
  cerebras: 1_000_000,  // free tier ~1M tokens/day
  mistral: 500_000,
  nvidia: 1_000_000,    // NIM free
  openrouter: 200_000,  // free models are request-capped — estimate
  github: 150_000,      // GitHub Models — low free limits
  zhipu: 1_000_000,     // free GLM models
  huggingface: 100_000,
  ollama: 500_000,
  opencode: 500_000,
  kilo: 500_000,
  cohere: 100_000,      // trial — request-capped — estimate
  cloudflare: 100_000,  // Workers AI free neurons/day — estimate
};

// The fallback per-key daily token cap for a model. Returns 0 when nothing is
// known (caller then shows tokens-used instead of a budget bar).
export function defaultDailyTokenCap(platform: string, model: string): number {
  const id = `${platform}/${model}`.toLowerCase();
  if (MODEL_TPD[id]) return MODEL_TPD[id];
  return PLATFORM_TPD[platform.toLowerCase()] ?? 0;
}
