import Groq from "groq-sdk";
import { MODEL_IDS } from "./models";

if (!process.env.GROQ_API_KEY) {
  throw new Error("GROQ_API_KEY is not set. Copy .env.local.example to .env.local.");
}

export const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// llama-3.3-70b is far more reliable at tool calling than 8b-instant
// (the 8b model frequently emits malformed function-call syntax).
export const DEFAULT_MODEL = "llama-3.3-70b-versatile";

// The full fallback chain (ids only), derived from the shared registry
// (lib/models.ts). The agent rotates through these — skipping disabled/exhausted
// ones — and Gemini leads. Kept here for back-compat with callers that only need
// the id list (e.g. the voice route's error fallback).
export const FALLBACK_MODELS = MODEL_IDS;
// whisper-large-v3 is Groq's most ACCURATE STT (≈8.4% WER) — a bit slower than
// the "-turbo" variant but noticeably better on names/commands. Same free tier.
export const STT_MODEL = "whisper-large-v3";

// Detect the real audio container from the file's magic bytes, so we hand Groq
// a filename + content-type that match the actual data. Browsers vary in what
// MediaRecorder produces (webm/opus, mp4, ogg), and the blob.type/filename can
// disagree with the bytes — when they do, Groq's Whisper picks the wrong decoder
// and returns "could not process file - is it a valid media file?".
export function sniffAudio(
  buf: Buffer,
  fallbackType = "audio/webm"
): { name: string; type: string; ext: string } {
  const b = buf;
  const ascii = (i: number, s: string) =>
    b.length >= i + s.length &&
    [...s].every((c, k) => b[i + k] === c.charCodeAt(0));

  let ext = "webm";
  let type = "audio/webm";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    ext = "webm"; type = "audio/webm"; // EBML (webm / matroska)
  } else if (ascii(0, "OggS")) {
    ext = "ogg"; type = "audio/ogg";
  } else if (ascii(4, "ftyp")) {
    ext = "mp4"; type = "audio/mp4";
  } else if (ascii(0, "RIFF") && ascii(8, "WAVE")) {
    ext = "wav"; type = "audio/wav";
  } else if (ascii(0, "ID3") || (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) {
    ext = "mp3"; type = "audio/mpeg";
  } else if (fallbackType.includes("mp4")) {
    ext = "mp4"; type = "audio/mp4";
  } else if (fallbackType.includes("ogg")) {
    ext = "ogg"; type = "audio/ogg";
  }
  return { name: `speech.${ext}`, type, ext };
}

// Live rate-limit info Groq returns on every response as `x-ratelimit-*`
// headers. This is the authoritative source for each model's per-minute /
// per-day ceilings (they vary by model and account tier, so we never hardcode).
export type RateLimits = {
  limitTokens?: number; // tokens allowed per window (TPM)
  remainingTokens?: number;
  resetTokens?: string; // e.g. "7.66s" until the token bucket refills
  limitRequests?: number; // requests allowed per window (usually per day)
  remainingRequests?: number;
  resetRequests?: string;
};

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Groq 429 errors say WHICH limit was hit and (usually) how long to wait, e.g.
// "Rate limit reached for model `x` ... on tokens per minute (TPM): Limit 12000,
// Used ... Please try again in 5.2s". Classify per-day (real quota, fall to the
// next model) vs per-minute (transient, retry shortly), and extract the wait.
export function classifyRateLimit(err: any): {
  scope: "day" | "minute" | "unknown";
  retryMs: number | null;
} {
  const msg = `${err?.message ?? ""} ${err?.error?.message ?? ""}`;
  // Day patterns cover Groq ("per day", TPD/RPD) and Gemini's OpenAI-compat
  // quota strings (e.g. "...RequestsPerDayPerProjectPerModel").
  const scope = /per day|\bRPD\b|\bTPD\b|tokens? per day|requests? per day|PerDay/i.test(msg)
    ? "day"
    : /per minute|\bTPM\b|\bRPM\b|tokens? per minute|requests? per minute|PerMinute/i.test(msg)
    ? "minute"
    : "unknown";
  // The `retry-after` header (seconds) is the most reliable wait. Fall back to
  // parsing "try again in 1m30s" / "5.2s" from the message.
  const retryAfter = Number(err?.headers?.["retry-after"]);
  let retryMs: number | null = Number.isFinite(retryAfter)
    ? retryAfter * 1000
    : null;
  if (retryMs == null) {
    let ms = 0;
    let matched = false;
    for (const [, v, u] of msg.matchAll(/([\d.]+)\s*(ms|s|m|h)(?![a-z])/gi)) {
      matched = true;
      const n = parseFloat(v);
      ms += u === "h" ? n * 3.6e6 : u === "m" ? n * 6e4 : u === "s" ? n * 1e3 : n;
    }
    if (matched) retryMs = ms;
  }
  return { scope, retryMs };
}

// Pull the authoritative per-day token usage from a TPD 429 message, e.g.
// "tokens per day (TPD): Limit 200000, Used 199773".
export function parseDailyUsage(
  err: any
): { used: number; limit: number } | null {
  const msg = `${err?.message ?? ""} ${err?.error?.message ?? ""}`;
  const m = msg.match(/Limit\s+(\d+),\s*Used\s+(\d+)/i);
  if (!m) return null;
  return { limit: Number(m[1]), used: Number(m[2]) };
}

export function parseRateLimits(headers: Headers): RateLimits {
  const num = (v: string | null) =>
    v == null || v === "" ? undefined : Number(v);
  return {
    limitTokens: num(headers.get("x-ratelimit-limit-tokens")),
    remainingTokens: num(headers.get("x-ratelimit-remaining-tokens")),
    resetTokens: headers.get("x-ratelimit-reset-tokens") ?? undefined,
    limitRequests: num(headers.get("x-ratelimit-limit-requests")),
    remainingRequests: num(headers.get("x-ratelimit-remaining-requests")),
    resetRequests: headers.get("x-ratelimit-reset-requests") ?? undefined,
  };
}
