// Email summarizer LLM calls. The filename is kept for compatibility with
// existing imports, but this now uses the native rotating /v1 router instead of
// the old direct Groq SDK fallback chain.
import { routeChatCompletion } from "@/lib/llm-router";
import type { RateLimits } from "@/lib/groq";
import type { GroqUsage, RawEmailLike, Summary } from "./types";

type CompletionResult = {
  completion: any;
  model: string;
  limits: RateLimits;
};

async function createWithRouter(params: {
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  temperature: number;
  max_tokens: number;
}): Promise<CompletionResult> {
  const result = await routeChatCompletion({ ...params, model: "auto" });
  if (!result.ok) throw new Error(result.error);
  if (!result.response.ok) {
    const text = await result.response.text().catch(() => "");
    let message = text || `router returned ${result.response.status}`;
    try {
      message = JSON.parse(text)?.error?.message || JSON.parse(text)?.error || message;
    } catch {
      /* keep raw text */
    }
    throw new Error(typeof message === "string" ? message : `router returned ${result.response.status}`);
  }
  const completion = await result.response.json();
  const model = String(completion?.model || "auto");
  return { completion, model, limits: {} };
}

const SYSTEM_PROMPT = `You are an email triage assistant. Given a list of emails, return a JSON array where each item has:
- emailId (string)
- account (string, the account label provided)
- from (string, sender email)
- subject (string)
- summary (string, 1-2 sentences)
- urgency (integer 1-5: 1=minimal/newsletter, 2=low/FYI, 3=medium/action needed, 4=high/deadline this week or VIP, 5=critical/urgent+VIP+deadline today)
- urgencyReason (string, brief explanation)
- category (string, one of the provided categories)
- actionItems (array of strings, empty if none)
- requiresReply (boolean)
- deadlineMentioned (string ISO date or null)

Return ONLY valid JSON array, no markdown, no explanation.`;

// Some fallback models (e.g. gpt-oss) wrap JSON in ```json fences or prepend
// stray text. Strip fences and slice to the outermost array before parsing,
// so an empty/decorated response doesn't throw "Unexpected end of JSON input".
function parseSummaryArray(raw: string | null | undefined): Summary[] {
  let text = (raw ?? "").trim();
  if (!text) return [];
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start !== -1 && end > start) text = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as Summary[]) : [];
  } catch {
    return [];
  }
}

const stripHtml = (html: string) =>
  html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

const ZERO_USAGE: GroqUsage = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

// Synthesize a single short sentence summarizing all emails in one category,
// from their already-computed per-email summaries.
export async function synthesizeCategorySummary(
  category: string,
  summaries: Pick<Summary, "subject" | "summary">[]
): Promise<{ text: string; usage: GroqUsage; model: string; limits: RateLimits }> {
  const items = summaries.map((s) => `- ${s.subject}: ${s.summary}`).join("\n");
  const isWork = /work|job|career/i.test(category);
  const hint = isWork
    ? " This is a work/jobs category — briefly name the specific job opportunities, roles, or listings mentioned."
    : "";
  const { completion, model, limits } = await createWithRouter({
    messages: [
      {
        role: "system",
        content: `Summarize this group of emails in ONE concise sentence (max 25 words). Mention the gist of what arrived. No preamble, no list, just the sentence.${hint}`,
      },
      { role: "user", content: `Category: ${category}\n\n${items}` },
    ],
    temperature: 0.2,
    max_tokens: 80,
  });
  const text = (completion.choices[0].message.content ?? "").trim();
  const usage = (completion.usage as GroqUsage | undefined) ?? ZERO_USAGE;
  return { text, usage, model, limits };
}

export async function summarizeEmails(
  emails: RawEmailLike[],
  categories: string[]
): Promise<{ summaries: Summary[]; usage: GroqUsage; model: string; limits: RateLimits }> {
  const userContent =
    JSON.stringify(
      emails.map((e) => ({
        emailId: e.id,
        account: e.account,
        from: e.from,
        subject: e.subject,
        body: stripHtml(e.body ?? "").slice(0, 300),
      }))
    ) + `\n\nAvailable categories: ${categories.join(", ")}`;

  const { completion, model, limits } = await createWithRouter({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0.1,
    max_tokens: 1500,
  });

  const summaries = parseSummaryArray(completion.choices[0]?.message?.content);
  const usage = (completion.usage as GroqUsage | undefined) ?? ZERO_USAGE;
  return { summaries, usage, model, limits };
}
