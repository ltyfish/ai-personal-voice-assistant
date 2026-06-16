// Live per-model status for the JARVIS deck and the agent's fallback ordering.
// Combines the registry, the user's enable/disable choice, Gemini availability,
// and the recorded daily-limit state so both the UI and the agent agree on which
// model is "active", which are "exhausted" (daily quota spent), and which the
// user turned off.

import { getGroqStats } from "./mail/blobs";
import { getModelConfig } from "./model-config";
import { getPlatformAvailability, disabledModelIds } from "./llm-router";
import { MODELS, type Provider } from "./models";

// Registry provider → the router's key-pool platform name (llm_keys.platform).
const PROVIDER_PLATFORM: Record<string, string> = { gemini: "google", groq: "groq" };

export type ModelStatus = {
  id: string;
  provider: Provider;
  label: string;
  enabled: boolean; // user hasn't disabled it
  available: boolean; // provider is configured (Gemini needs a key)
  exhausted: boolean; // daily limit hit and not yet reset
  cooledDown: boolean; // every key for this platform is in 429 cooldown RIGHT NOW
  coolResetAt?: string | null; // when the soonest key leaves cooldown
  active: boolean; // the one the next request will use
  tokensToday: number;
  tpd?: number;
  rpd?: number;
  resetAt?: string | null;
};

export async function computeModelStatus(): Promise<{
  models: ModelStatus[];
  activeId: string | null;
  exhaustedIds: string[];
}> {
  const [stats, cfg, platformAvail, routerDisabled] = await Promise.all([
    getGroqStats(),
    getModelConfig(),
    getPlatformAvailability().catch(() => ({} as Record<string, { total: number; available: number; soonestResetAt: string | null }>)),
    // Models disabled on the LLM Keys page (llm_models.enabled = false), keyed by
    // "<platform>/<model>". The agent's chain must skip these too, or a model the
    // user turned off there keeps getting rotated into voice turns.
    disabledModelIds().catch(() => new Set<string>()),
  ]);
  const disabled = new Set(cfg.disabled);
  const now = Date.now();

  let activeId: string | null = null;
  const exhaustedIds: string[] = [];

  const models: ModelStatus[] = MODELS.map((m) => {
    const platform = PROVIDER_PLATFORM[m.provider] ?? m.provider;
    const avail = platformAvail[platform];
    const hasRouterKeys = !!(avail && avail.total > 0);
    const available = hasRouterKeys;
    const lim = stats.limits[m.id];
    const exhausted = !!(lim?.dailyResetAt && new Date(lim.dailyResetAt).getTime() > now);
    if (exhausted) exhaustedIds.push(m.id);
    const enabled = !disabled.has(m.id) && !routerDisabled.has(`${platform}/${m.id}`);
    // Live 429 cooldown: the platform has keys but every one is cooling right now.
    const cooledDown = !!(avail && avail.total > 0 && avail.available === 0);
    // A cooled-down model isn't a candidate for "active" either (it can't run now).
    if (available && enabled && !exhausted && !cooledDown && !activeId) activeId = m.id;
    return {
      id: m.id,
      provider: m.provider,
      label: m.label,
      enabled,
      available,
      exhausted,
      cooledDown,
      coolResetAt: cooledDown ? avail?.soonestResetAt ?? null : null,
      active: false,
      tokensToday: Math.max(stats.byModel[m.id]?.tokens ?? 0, lim?.dailyTokensUsed ?? 0),
      tpd: lim?.dailyTokensLimit ?? m.tpd,
      rpd: m.rpd,
      resetAt: lim?.dailyResetAt ?? null,
    };
  });
  for (const m of models) m.active = m.id === activeId;

  return { models, activeId, exhaustedIds };
}
