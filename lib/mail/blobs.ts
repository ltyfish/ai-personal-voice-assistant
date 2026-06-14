// Storage layer for the embedded email-summarizer.
// Originally backed by Netlify Blobs; reimplemented against the project's Neon
// Postgres so the rest of the ported code keeps the same function surface.
import { and, eq } from "drizzle-orm";
import { db, mailKv, mailSummaries } from "@/db";
import type {
  GroqStats,
  GroqUsage,
  DigestState,
  MailConfig,
  PollState,
  Summary,
} from "./types";

export type { GroqStats, GroqUsage, MailConfig, PollState, Summary } from "./types";

// Date key for storing/looking up summaries. MUST be the user's LOCAL date (the
// UI's date picker is local), not UTC — otherwise an email received after
// local-midnight but before UTC-midnight is filed under "yesterday" and the
// Inbox/Digest for today looks empty even though the email exists.
const MAIL_TZ = process.env.ASSISTANT_TIMEZONE || "Asia/Singapore";
export function localDateKey(input: string | number | Date): string {
  const d = input instanceof Date ? input : new Date(input);
  // en-CA formats as YYYY-MM-DD; timeZone shifts to the user's local day.
  return new Intl.DateTimeFormat("en-CA", { timeZone: MAIL_TZ }).format(d);
}

export const makeKey = (date: string, id: string) => `${date}/${id}`;

export const parseKey = (key: string) => {
  const [date, id] = key.split("/");
  return { date, id };
};

// ---- generic KV helpers ----
async function kvGet<T>(namespace: string, key: string): Promise<T | null> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, namespace), eq(mailKv.key, key)));
  return rows.length ? (rows[0].value as T) : null;
}

async function kvSet(namespace: string, key: string, value: unknown) {
  await db
    .insert(mailKv)
    .values({ namespace, key, value: value as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: value as object, updatedAt: new Date() },
    });
}

// ---- config ----
export function getDefaultConfig(): MailConfig {
  return {
    accounts: [],
    vipSenders: [],
    categories: ["Work", "School", "Finance", "Personal", "Newsletters", "Promotions"],
    notifications: {
      telegram: { enabled: false, botToken: "", chatId: "" },
      whatsapp: { enabled: false, twilioSid: "", twilioToken: "", userPhone: "" },
      digestTimes: ["07:00"],
      instantAlertThreshold: 5,
    },
    pollingIntervalMin: 10,
  };
}

export async function getConfig(): Promise<MailConfig> {
  return (await kvGet<MailConfig>("settings", "config")) ?? getDefaultConfig();
}

export async function saveConfig(config: MailConfig) {
  await kvSet("settings", "config", config);
}

// ---- poll state ----
export async function getPollState(): Promise<PollState> {
  return (await kvGet<PollState>("state", "poll-state")) ?? { accounts: {} };
}

export async function savePollState(state: PollState) {
  await kvSet("state", "poll-state", state);
}

// ---- digest state ----
export async function getDigestState(): Promise<DigestState> {
  return (await kvGet<DigestState>("state", "digest-state")) ?? { sent: {} };
}

export async function saveDigestState(state: DigestState) {
  await kvSet("state", "digest-state", state);
}

// ---- groq stats ----
const EVENTS_WINDOW_MS = 60 * 60 * 1000; // keep last hour of call events

// Normalize older stored shapes (which lacked byModel/events/limits/days)
// so callers always get a fully-populated object.
export async function getGroqStats(): Promise<GroqStats> {
  const raw = await kvGet<Partial<GroqStats>>("state", "groq-stats");
  const stats: GroqStats = {
    today: raw?.today ?? null,
    allTime: {
      tokens: raw?.allTime?.tokens ?? 0,
      calls: raw?.allTime?.calls ?? 0,
      days: raw?.allTime?.days ?? (raw?.today ? 1 : 0),
      firstDate: raw?.allTime?.firstDate ?? raw?.today?.date ?? null,
    },
    byModel: raw?.byModel ?? {},
    byModelAllTime: raw?.byModelAllTime ?? {},
    events: raw?.events ?? [],
    limits: raw?.limits ?? {},
  };

  // Groq's daily token bucket is a ROLLING window. When a model's captured
  // `dailyResetAt` has passed, that bucket has refilled — so the "tokens today"
  // tally toward the daily cap is stale and must drop back to zero (otherwise it
  // stays pinned at the over-limit number until the next UTC-midnight rollover).
  const now = Date.now();
  let changed = false;
  for (const [model, lim] of Object.entries(stats.limits)) {
    const resetPassed =
      lim.dailyResetAt != null && new Date(lim.dailyResetAt).getTime() <= now;
    // A captured daily count older than 24h is stale even without a reset time
    // (the rolling window has fully turned over since we recorded it).
    const captureStale =
      lim.dailyTokensUsed != null &&
      lim.capturedAt != null &&
      now - new Date(lim.capturedAt).getTime() >= 24 * 60 * 60 * 1000;
    if (resetPassed || captureStale) {
      if (stats.byModel[model]) {
        stats.byModel[model].tokens = 0;
        stats.byModel[model].calls = 0;
      }
      delete lim.dailyResetAt;
      delete lim.dailyTokensUsed;
      changed = true;
    }
  }
  if (changed) await kvSet("state", "groq-stats", stats);

  return stats;
}

export async function addGroqUsage(
  usage: GroqUsage,
  info?: { model?: string; limits?: import("@/lib/groq").RateLimits | null }
) {
  const stats = await getGroqStats();
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const isNewDay = !stats.today || stats.today.date !== today;

  if (isNewDay) {
    stats.today = {
      date: today,
      tokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      calls: 0,
    };
    stats.allTime.days += 1;
    if (!stats.allTime.firstDate) stats.allTime.firstDate = today;
  }
  stats.today!.tokens += usage.total_tokens;
  stats.today!.promptTokens += usage.prompt_tokens;
  stats.today!.completionTokens += usage.completion_tokens;
  stats.today!.calls += 1;

  stats.allTime.tokens += usage.total_tokens;
  stats.allTime.calls += 1;

  // Per-model breakdown (reset when the day rolls over).
  if (info?.model) {
    const m = stats.byModel[info.model];
    if (!m || m.date !== today) {
      stats.byModel[info.model] = { date: today, tokens: 0, calls: 0 };
    }
    stats.byModel[info.model].tokens += usage.total_tokens;
    stats.byModel[info.model].calls += 1;

    const at = stats.byModelAllTime[info.model] ?? { tokens: 0, calls: 0 };
    at.tokens += usage.total_tokens;
    at.calls += 1;
    stats.byModelAllTime[info.model] = at;
  }

  // Rolling event log for per-minute rate, pruned to the last hour.
  stats.events.push({ ts: now, tokens: usage.total_tokens });
  stats.events = stats.events.filter((e) => e.ts >= now - EVENTS_WINDOW_MS);

  // Latest known ceilings for this model.
  if (info?.model && info.limits) {
    stats.limits[info.model] = {
      ...info.limits,
      capturedAt: new Date(now).toISOString(),
    };
  }

  await kvSet("state", "groq-stats", stats);
}

// Capture the truth Groq only exposes on a 429: authoritative per-day token
// usage (from the message) and the live per-minute/request ceilings + reset
// (from the error headers). This makes the dashboard reflect reality right after
// a limit, instead of optimistic numbers extrapolated from the last success.
export async function recordRateLimit(
  model: string,
  info: {
    limits?: Partial<import("@/lib/groq").RateLimits>;
    dailyUsed?: number;
    dailyLimit?: number;
    dailyResetMs?: number | null;
  }
) {
  const stats = await getGroqStats();
  const today = new Date().toISOString().slice(0, 10);

  // Bump our per-model "tokens today" up to Groq's authoritative count.
  if (info.dailyUsed != null) {
    const m = stats.byModel[model] ?? { date: today, tokens: 0, calls: 0 };
    if (m.date !== today) {
      m.date = today;
      m.calls = 0;
    }
    m.tokens = Math.max(m.tokens, info.dailyUsed);
    stats.byModel[model] = m;
  }

  stats.limits[model] = {
    ...(stats.limits[model] ?? {}),
    ...(info.limits ?? {}),
    ...(info.dailyLimit != null ? { dailyTokensLimit: info.dailyLimit } : {}),
    ...(info.dailyUsed != null ? { dailyTokensUsed: info.dailyUsed } : {}),
    ...(info.dailyResetMs != null
      ? { dailyResetAt: new Date(Date.now() + info.dailyResetMs).toISOString() }
      : {}),
    capturedAt: new Date().toISOString(),
  };

  await kvSet("state", "groq-stats", stats);
}

// Force a daily-quota re-check for the given models: drop their recorded
// `dailyResetAt`/`dailyTokensUsed` and zero today's per-model tally, so
// `computeModelStatus` stops treating them as exhausted and the agent re-probes
// them on the next request. If the provider is still over quota, the next 429
// re-records the limit (via `recordRateLimit`) and the model goes back to
// "daily quota hit" — i.e. unticking the box re-scans, and it re-ticks if it's
// genuinely still blocked.
export async function clearModelDailyLimit(models: string[]) {
  if (!models?.length) return;
  const stats = await getGroqStats();
  let changed = false;
  for (const model of models) {
    const lim = stats.limits[model];
    if (lim && (lim.dailyResetAt != null || lim.dailyTokensUsed != null)) {
      delete lim.dailyResetAt;
      delete lim.dailyTokensUsed;
      changed = true;
    }
    if (stats.byModel[model] && (stats.byModel[model].tokens || stats.byModel[model].calls)) {
      stats.byModel[model].tokens = 0;
      stats.byModel[model].calls = 0;
      changed = true;
    }
  }
  if (changed) await kvSet("state", "groq-stats", stats);
}

// ---- summaries ----
export async function getSummary(
  date: string,
  emailId: string
): Promise<Summary | null> {
  const rows = await db
    .select({ data: mailSummaries.data })
    .from(mailSummaries)
    .where(and(eq(mailSummaries.date, date), eq(mailSummaries.emailId, emailId)));
  return rows.length ? (rows[0].data as Summary) : null;
}

export async function setSummary(date: string, emailId: string, summary: Summary) {
  await db
    .insert(mailSummaries)
    .values({ date, emailId, data: summary })
    .onConflictDoUpdate({
      target: [mailSummaries.date, mailSummaries.emailId],
      set: { data: summary },
    });
}

export async function hasSummary(date: string, emailId: string): Promise<boolean> {
  return (await getSummary(date, emailId)) !== null;
}

export async function saveSummary(summary: Summary) {
  const date = localDateKey(summary.receivedAt);
  await setSummary(date, summary.emailId, summary);
}

export async function listSummaries(
  {
    date,
    account,
    category,
    urgency,
    reviewed,
  }: {
    date?: string;
    account?: string;
    category?: string;
    urgency?: string;
    reviewed?: string;
  } = {}
): Promise<Summary[]> {
  const rows = date
    ? await db
        .select({ data: mailSummaries.data })
        .from(mailSummaries)
        .where(eq(mailSummaries.date, date))
    : await db.select({ data: mailSummaries.data }).from(mailSummaries);

  const results = rows.map((r) => r.data as Summary);
  return results
    .filter((s) => {
      if (!s) return false;
      if (account && s.account !== account) return false;
      if (category && s.category !== category) return false;
      if (urgency && s.urgency < Number(urgency)) return false;
      if (reviewed !== undefined && s.reviewed !== (reviewed === "true")) return false;
      return true;
    })
    .sort(
      (a, b) => b.urgency - a.urgency || b.receivedAt.localeCompare(a.receivedAt)
    );
}
