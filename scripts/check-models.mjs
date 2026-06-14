// Pings every model in FALLBACK_MODELS with a tiny request and reports which
// actually work (and which 404/decommission). Run: node scripts/check-models.mjs
import { readFileSync } from "node:fs";
import Groq from "groq-sdk";

// Load GROQ_API_KEY from .env.local (same as drizzle config does).
try {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^\s*([\w.]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

const MODELS = [
  "llama-3.3-70b-versatile",
  "meta-llama/llama-4-scout-17b-16e-instruct",
  "qwen/qwen3-32b",
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
];

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

for (const model of MODELS) {
  try {
    const { data, response } = await groq.chat.completions
      .create({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 5,
        temperature: 0,
      })
      .withResponse();
    const tpd = response.headers.get("x-ratelimit-limit-tokens") || "?";
    const reply = (data.choices[0]?.message?.content || "").trim().slice(0, 20);
    console.log(`✅ ${model.padEnd(46)} -> "${reply}"  (TPM limit ${tpd})`);
  } catch (err) {
    const status = err?.status ?? "?";
    const msg = (err?.error?.error?.message || err?.message || "").slice(0, 90);
    const tag = status === 429 ? "⏳ RATE-LIMITED" : "❌ FAIL";
    console.log(`${tag} ${model.padEnd(46)} -> [${status}] ${msg}`);
  }
}
