import { requireAuth, json } from "@/lib/mail/auth";
import { getGroqStats } from "@/lib/mail/blobs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: Request) {
  const authError = requireAuth(req);
  if (authError) return authError;

  const stats = await getGroqStats();
  const now = Date.now();
  const events = stats.events ?? [];

  // Tokens in the trailing 60 seconds — the live "right now" rate.
  const tokensLastMinute = events
    .filter((e) => e.ts >= now - 60_000)
    .reduce((s, e) => s + e.tokens, 0);

  // Average tokens/minute over the span we have events for (last hour),
  // so it reflects actual active usage rather than diluting across idle time.
  const oldest = events.length ? Math.min(...events.map((e) => e.ts)) : now;
  const spanMinutes = Math.max((now - oldest) / 60_000, 1);
  const windowTokens = events.reduce((s, e) => s + e.tokens, 0);
  const avgTokensPerMinute = events.length
    ? Math.round(windowTokens / spanMinutes)
    : 0;

  // Average tokens/day over all distinct days we've tracked.
  const days = Math.max(stats.allTime.days, 1);
  const avgTokensPerDay = Math.round(stats.allTime.tokens / days);

  // The "active" model = whichever we most recently got headers for. Its
  // remaining tokens/min and requests/day are the live binding ceilings.
  const limitEntries = Object.entries(stats.limits ?? {});
  limitEntries.sort(
    (a, b) =>
      new Date(b[1].capturedAt).getTime() - new Date(a[1].capturedAt).getTime()
  );
  const [activeModel, activeLimits] = limitEntries[0] ?? [null, null];

  return json({
    ...stats,
    computed: {
      tokensLastMinute,
      avgTokensPerMinute,
      avgTokensPerDay,
      activeModel,
      activeLimits,
      now,
    },
  });
}
