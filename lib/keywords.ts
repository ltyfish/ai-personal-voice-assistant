// Custom keyword overrides for the ability registry (lib/abilities.ts), at both
// levels: group keywords and per-function keywords. Stored in mail_kv (namespace
// "keywords", key "map") — same pattern as contacts. We persist only what differs
// from the built-in defaults; everything else falls back to the registry.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";
import { ABILITIES, type KeywordMap, type AbilityOverride } from "./abilities";

const NS = "keywords";
const KEY = "map";

export async function getKeywordMap(): Promise<KeywordMap> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)));
  const v = rows.length ? (rows[0].value as { map?: KeywordMap }) : null;
  return v && typeof v.map === "object" && v.map ? v.map : {};
}

const dedupe = (list: unknown): string[] =>
  Array.isArray(list)
    ? [...new Set(list.map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean))]
    : [];
const norm = (list: string[]) => [...list].sort().join("|");

// Keep only valid, non-default overrides for known abilities/functions.
function sanitize(input: KeywordMap): KeywordMap {
  const out: KeywordMap = {};
  for (const a of ABILITIES) {
    const raw = input?.[a.id];
    if (!raw || typeof raw !== "object") continue;
    const entry: AbilityOverride = {};

    const group = dedupe(raw.group);
    if (group.length && norm(group) !== norm(a.defaultGroupKeywords.map((k) => k.toLowerCase())))
      entry.group = group;

    if (raw.fns && typeof raw.fns === "object") {
      const fns: Record<string, string[]> = {};
      for (const f of a.functions) {
        const list = dedupe(raw.fns[f.tool]);
        if (list.length && norm(list) !== norm(f.defaultKeywords.map((k) => k.toLowerCase())))
          fns[f.tool] = list;
      }
      if (Object.keys(fns).length) entry.fns = fns;
    }

    // Routing priority: a positive integer (lower wins a shared keyword).
    const p = Number((raw as { priority?: unknown }).priority);
    if (Number.isFinite(p) && p >= 1) entry.priority = Math.floor(p);

    if (entry.group || entry.fns || entry.priority != null) out[a.id] = entry;
  }
  return out;
}

export async function saveKeywordMap(input: KeywordMap): Promise<KeywordMap> {
  const map = sanitize(input);
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: { map } as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: { map } as object, updatedAt: new Date() },
    });
  return map;
}
