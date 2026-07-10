import { NextResponse } from "next/server";
import { asc } from "drizzle-orm";
import { db, llmKeys, llmModels, llmUsage } from "@/db";
import { FALLBACK_AUTO_CHAIN, PROVIDERS, getActiveModelCooldowns, normalizeModelCooldownCatalogId } from "@/lib/llm-router";
import { byBestModel, modelRank } from "@/lib/model-rank";
import { defaultDailyTokenCap } from "@/lib/model-budget";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET — token usage for the LLM-Keys + Pipeline dashboards. Aggregates the per
// (key, model) rows written by the /v1 rotation proxy into:
//   - models: one row per (platform, model), summed across every key that served
//     it, ordered best-first (curated capability rank). EVERY enabled catalog
//     model appears here even at 0 usage, so the board lists all free models a
//     provider serves (not just ones that happen to have been used yet).
//   - providers: per-platform totals + how many keys each has.
//   - keys: per-key totals (label/masked-ish identity for the multi-account view).
// Each model row carries `dayCap` = its per-key daily token budget x the number
// of enabled keys for that provider (the real catalog tpd wins; a researched
// fallback fills the gap). `remaining today = dayCap - todayTokens`, so the bar
// starts full and the rotation's recorded usage deducts from it.
// Today's bucket only counts rows whose stored day matches the current UTC day,
// so a stale `today_tokens` from a previous day reads as 0 without a cron reset.
export async function GET() {
  const today = new Date().toISOString().slice(0, 10);
  const [usage, keys, catalog, modelCooldowns] = await Promise.all([
    db.select().from(llmUsage),
    db.select().from(llmKeys).orderBy(asc(llmKeys.platform), asc(llmKeys.createdAt)),
    db.select().from(llmModels),
    getActiveModelCooldowns(),
  ]);

  // Enabled keys per platform — the multiplier for a model's combined daily
  // budget (more keys = more free quota) and what decides which catalog models
  // to surface (only providers you actually hold a key for).
  const enabledKeyCount: Record<string, number> = {};
  const anyKey = new Set<string>();
  for (const k of keys) {
    anyKey.add(k.platform);
    if (k.enabled) enabledKeyCount[k.platform] = (enabledKeyCount[k.platform] ?? 0) + 1;
  }

  // per (platform, model)
  type ModelAgg = {
    platform: string; model: string;
    enabled: boolean;
    source: string;
    totalTokens: number; todayTokens: number;
    promptTokens: number; completionTokens: number;
    requests: number; keyCount: number; dayCap: number;
  };
  const models = new Map<string, ModelAgg>();
  const mkKey = (platform: string, model: string) => `${platform} ${model}`;
  const dayCapFor = (platform: string, model: string, tpd: number | null) => {
    const perKey = tpd && tpd > 0 ? tpd : defaultDailyTokenCap(platform, model);
    const nKeys = enabledKeyCount[platform] ?? 0;
    return perKey > 0 ? perKey * Math.max(1, nKeys) : 0;
  };

  // Seed from the catalog so every model a provider serves shows up
  // (full budget, 0 used) even before its first request. Skip providers with no
  // key at all — you can't run those, so they'd just be noise.
  for (const c of catalog) {
    if (!anyKey.has(c.platform)) continue;
    models.set(mkKey(c.platform, c.model), {
      platform: c.platform, model: c.model, enabled: c.enabled, source: c.source || "catalog",
      totalTokens: 0, todayTokens: 0, promptTokens: 0, completionTokens: 0,
      requests: 0, keyCount: enabledKeyCount[c.platform] ?? 0,
      dayCap: dayCapFor(c.platform, c.model, c.tpdLimit),
    });
  }

  // Also surface the built-in fallback auto-chain. These are real rotation
  // candidates whenever the external catalog is unavailable or empty, so users
  // must be able to see and disable them before they are first used.
  for (const id of FALLBACK_AUTO_CHAIN) {
    const slash = id.indexOf("/");
    const platform = slash > 0 ? id.slice(0, slash) : "";
    const model = slash > 0 ? id.slice(slash + 1) : "";
    if (!platform || !model || !PROVIDERS[platform] || !anyKey.has(platform)) continue;
    const key = mkKey(platform, model);
    if (models.has(key)) continue;
    models.set(key, {
      platform, model, enabled: true, source: "fallback",
      totalTokens: 0, todayTokens: 0, promptTokens: 0, completionTokens: 0,
      requests: 0, keyCount: enabledKeyCount[platform] ?? 0,
      dayCap: dayCapFor(platform, model, null),
    });
  }

  // per key
  const keyTotals = new Map<string, { total: number; today: number; requests: number }>();

  for (const u of usage) {
    const mk = mkKey(u.platform, u.model);
    let m = models.get(mk);
    if (!m) {
      // A used model not in the catalog (catalog not synced yet) — still surface
      // it, with a fallback budget.
      m = {
        platform: u.platform, model: u.model, enabled: true, source: "usage", totalTokens: 0, todayTokens: 0,
        promptTokens: 0, completionTokens: 0, requests: 0,
        keyCount: enabledKeyCount[u.platform] ?? 0,
        dayCap: dayCapFor(u.platform, u.model, null),
      };
      models.set(mk, m);
    }
    const todayTok = u.todayDate === today ? u.todayTokens : 0;
    m.totalTokens += u.totalTokens;
    m.todayTokens += todayTok;
    m.promptTokens += u.promptTokens;
    m.completionTokens += u.completionTokens;
    m.requests += u.requests;

    const kt = keyTotals.get(u.keyId) ?? { total: 0, today: 0, requests: 0 };
    kt.total += u.totalTokens;
    kt.today += todayTok;
    kt.requests += u.requests;
    keyTotals.set(u.keyId, kt);
  }

  const modelRows = [...models.values()]
    .map((m) => {
      const cd = modelCooldowns[normalizeModelCooldownCatalogId(m.model)];
      return {
        ...m,
        rank: modelRank(m.model),
        cooledDown: !!cd,
        cooldownUntil: cd?.until ?? null,
        cooldownDetail: cd?.detail ?? null,
      };
    })
    .sort(byBestModel((m) => m.model));

  // ── Cross-provider leaderboard (best → worst) ──────────────────────────────
  // Unlike the per-provider `models` board (which only lists providers you hold a
  // key for), this lists EVERY known model — catalog ∪ fallback chain ∪ recorded
  // usage — regardless of whether its provider has a key, so any model can be
  // seen and DISABLED here (e.g. the NVIDIA Llama-4-Maverick fallback even with
  // no NVIDIA key). Disabling persists via PATCH /api/llm-models (it upserts).
  const tokensByModel = new Map<string, { today: number; total: number }>();
  for (const u of usage) {
    const k = mkKey(u.platform, u.model);
    const t = tokensByModel.get(k) ?? { today: 0, total: 0 };
    t.total += u.totalTokens;
    t.today += u.todayDate === today ? u.todayTokens : 0;
    tokensByModel.set(k, t);
  }
  const catalogEnabled = new Map<string, boolean>();
  for (const c of catalog) catalogEnabled.set(mkKey(c.platform, c.model), c.enabled);

  const lbSeen = new Set<string>();
  const leaderboard: Array<{
    platform: string; model: string; source: string; rank: number;
    enabled: boolean; hasKey: boolean; cooledDown: boolean;
    cooldownUntil: string | null; cooldownDetail: string | null;
    todayTokens: number; totalTokens: number;
  }> = [];
  const addLb = (platform: string, model: string, source: string) => {
    if (!platform || !model || !PROVIDERS[platform]) return;
    const k = mkKey(platform, model);
    if (lbSeen.has(k)) return;
    lbSeen.add(k);
    const cd = modelCooldowns[normalizeModelCooldownCatalogId(model)];
    const tok = tokensByModel.get(k) ?? { today: 0, total: 0 };
    leaderboard.push({
      platform, model, source,
      rank: modelRank(model),
      enabled: catalogEnabled.get(k) ?? true,
      hasKey: anyKey.has(platform),
      cooledDown: !!cd,
      cooldownUntil: cd?.until ?? null,
      cooldownDetail: cd?.detail ?? null,
      todayTokens: tok.today,
      totalTokens: tok.total,
    });
  };
  for (const c of catalog) addLb(c.platform, c.model, c.source || "catalog");
  for (const id of FALLBACK_AUTO_CHAIN) {
    const s = id.indexOf("/");
    if (s > 0) addLb(id.slice(0, s), id.slice(s + 1), "fallback");
  }
  for (const u of usage) addLb(u.platform, u.model, "usage");
  leaderboard.sort(byBestModel((m) => m.model));

  // Per-platform rollup.
  const providers = new Map<string, { platform: string; totalTokens: number; todayTokens: number; requests: number; keyCount: number }>();
  for (const k of keys) {
    const p = providers.get(k.platform) ?? { platform: k.platform, totalTokens: 0, todayTokens: 0, requests: 0, keyCount: 0 };
    p.keyCount += 1;
    providers.set(k.platform, p);
  }
  for (const m of modelRows) {
    const p = providers.get(m.platform) ?? { platform: m.platform, totalTokens: 0, todayTokens: 0, requests: 0, keyCount: 0 };
    p.totalTokens += m.totalTokens;
    p.todayTokens += m.todayTokens;
    p.requests += m.requests;
    providers.set(m.platform, p);
  }

  // Per-key, with identity for the multi-account view. Numbering same-platform
  // keys is left to the client (it already does this for the old board).
  const keyRows = keys.map((k) => {
    const t = keyTotals.get(k.id) ?? { total: 0, today: 0, requests: 0 };
    return {
      id: k.id,
      platform: k.platform,
      label: k.label,
      enabled: k.enabled,
      totalTokens: t.total,
      todayTokens: t.today,
      requests: t.requests,
    };
  });

  return NextResponse.json({
    models: modelRows,
    leaderboard,
    providers: [...providers.values()].sort((a, b) => a.platform.localeCompare(b.platform)),
    keys: keyRows,
  });
}
