// User-defined WEBSITE SHORTCUTS: a keyword → URL the user opens often. Stored in
// mail_kv (namespace "shortcuts", key "list"), same pattern as keywords/contacts.
// These are now part of the user's "about me" memory (lib/memory.ts): they're
// rendered into memory.md and the model opens them by name on its own — there's no
// deterministic keyword routing anymore.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";

const NS = "shortcuts";
const KEY = "list";

export type Shortcut = { keyword: string; url: string };

// Ensure a saved URL is openable: keep a full URL/scheme as-is, otherwise prefix
// https:// (so "netlify.com/home" → "https://netlify.com/home", preserving the
// path — we deliberately do NOT run it through resolveUrl, which mangles paths).
function normalizeUrl(raw: string): string {
  const u = (raw || "").trim();
  if (!u) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u; // already has a scheme
  return "https://" + u.replace(/^\/+/, "");
}

function sanitize(input: unknown): Shortcut[] {
  if (!Array.isArray(input)) return [];
  const out: Shortcut[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const keyword = String((raw as { keyword?: unknown })?.keyword ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
    const url = normalizeUrl(String((raw as { url?: unknown })?.url ?? ""));
    if (!keyword || !url || seen.has(keyword)) continue;
    seen.add(keyword);
    out.push({ keyword, url });
    if (out.length >= 100) break;
  }
  return out;
}

export async function getShortcuts(): Promise<Shortcut[]> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)));
  const v = rows.length ? (rows[0].value as { list?: unknown }) : null;
  return sanitize(v?.list);
}

export async function saveShortcuts(input: unknown): Promise<Shortcut[]> {
  const list = sanitize(input);
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: { list } as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: { list } as object, updatedAt: new Date() },
    });
  return list;
}
