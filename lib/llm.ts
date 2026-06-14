// Provider-agnostic chat completion. Both Groq and Gemini speak the OpenAI chat
// shape (choices[].message.tool_calls, usage), so the agent's tool-calling loop
// is identical across providers — only the transport differs here.
//
// JARVIS's OWN rotating router (lib/llm-router.ts → the llm_keys free-tier key
// pool): the same key rotation the /api/v1 proxy uses, called IN-PROCESS here
// (no HTTP hop, since this already runs server-side). Cloud voice and local
// voice therefore use the same key/model rotation source.

import type { ModelDef } from "./models";
import { routeChatCompletion } from "./llm-router";

export function geminiAvailable(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

export type CompletionParams = {
  messages: any[];
  tools?: any[];
  tool_choice?: "auto";
  temperature?: number;
  max_tokens?: number;
};

export type CompletionResult = {
  completion: any; // OpenAI-shaped { choices, usage }
  headers: Headers; // for Groq's x-ratelimit-* parsing (empty-ish for Gemini)
};

// Throw an error shaped like the Groq SDK's (status + error.message + headers)
// so the agent's existing 429 / decommission handling works for Gemini too.
function makeError(status: number, message: string, headers?: Record<string, string>) {
  const err: any = new Error(message);
  err.status = status;
  err.error = { message };
  if (headers) err.headers = headers;
  return err;
}

// Map a registry ModelDef to the router's "<platform>/<model-id>" id. The
// registry's "gemini" provider is Google's OpenAI-compat endpoint, which the
// router registers under the "google" platform.
function routerModelId(model: ModelDef): string {
  const platform = model.provider === "gemini" ? "google" : model.provider;
  return `${platform}/${model.id}`;
}

export async function createCompletion(
  model: ModelDef,
  params: CompletionParams
): Promise<CompletionResult> {
  return tryRouter(model, params);
}

// Route through lib/llm-router (the llm_keys pool). Cloud and local both use
// this same router/key pool; direct env-key completions are intentionally not a
// fallback because they would make the two paths rotate differently.
async function tryRouter(
  model: ModelDef,
  params: CompletionParams
): Promise<CompletionResult> {
  const result = await routeChatCompletion({ model: routerModelId(model), ...params });
  if (!result.ok) {
    throw makeError(result.status, result.error);
  }
  const res = result.response;
  // The router passes a non-retryable upstream client error straight through
  // (e.g. 400 unknown model, a real 429). Surface it as a thrown error shaped
  // like the SDK's so the agent's rotation/decommission logic handles it.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = text;
    try {
      msg = JSON.parse(text)?.error?.message || text;
    } catch {
      /* keep raw text */
    }
    throw makeError(
      res.status,
      msg || `LLM request failed (${res.status})`,
      Object.fromEntries(res.headers.entries())
    );
  }
  const completion = await res.json();
  return { completion, headers: res.headers };
}
