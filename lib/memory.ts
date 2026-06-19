// "About me" MEMORY — the facts Jarvis always reads. This is NOT a conversation
// log; it's the user's own context: website shortcuts, site logins, per-site
// startup steps, and free-text notes. The model reads this block every turn and
// acts on it naturally (no keywords, no deterministic routing).
//
// Source of truth lives in the cloud DB (mail_kv) so BOTH the cloud server loop
// and the local prep route can read it (Vercel can't read local fs; the browser's
// localStorage isn't visible server-side). Locally it's also mirrored into
// memory.md in OLLAMA_DIR for the Obsidian vault — see lib/ollama-context.ts.
//
// Website shortcuts keep their own existing store (lib/shortcuts.ts); logins,
// startups and notes live here under namespace "memory", key "profile". Same
// sanitize + onConflictDoUpdate pattern as lib/shortcuts.ts.

import { and, eq } from "drizzle-orm";
import { db, mailKv } from "@/db";
import { getShortcuts, type Shortcut } from "./shortcuts";

const NS = "memory";
const KEY = "profile";

export type Login = { host: string; username: string; password: string };
export type Startup = { url: string; command: string };

export type Memory = {
  shortcuts: Shortcut[];
  logins: Login[];
  startups: Startup[];
  notes: string;
};

// What we persist (shortcuts live in their own store, so they're not duplicated).
type StoredProfile = { logins: Login[]; startups: Startup[]; notes: string };

function str(v: unknown): string {
  return String(v ?? "").trim();
}

function sanitizeLogins(input: unknown): Login[] {
  if (!Array.isArray(input)) return [];
  const out: Login[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const r = raw as Partial<Login>;
    const host = str(r?.host).toLowerCase();
    const username = str(r?.username);
    const password = str(r?.password);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push({ host, username, password });
    if (out.length >= 100) break;
  }
  return out;
}

function sanitizeStartups(input: unknown): Startup[] {
  if (!Array.isArray(input)) return [];
  const out: Startup[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const r = raw as Partial<Startup>;
    const url = str(r?.url).toLowerCase();
    const command = str(r?.command);
    if (!url || !command || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, command });
    if (out.length >= 100) break;
  }
  return out;
}

async function readProfile(): Promise<StoredProfile> {
  const rows = await db
    .select({ value: mailKv.value })
    .from(mailKv)
    .where(and(eq(mailKv.namespace, NS), eq(mailKv.key, KEY)));
  const v = rows.length ? (rows[0].value as Partial<StoredProfile>) : null;
  return {
    logins: sanitizeLogins(v?.logins),
    startups: sanitizeStartups(v?.startups),
    notes: str(v?.notes),
  };
}

async function writeProfile(p: StoredProfile): Promise<void> {
  await db
    .insert(mailKv)
    .values({ namespace: NS, key: KEY, value: p as object })
    .onConflictDoUpdate({
      target: [mailKv.namespace, mailKv.key],
      set: { value: p as object, updatedAt: new Date() },
    });
}

// The full "about me" picture: shortcuts (their own store) + the profile fields.
export async function getMemory(): Promise<Memory> {
  const [shortcuts, profile] = await Promise.all([getShortcuts(), readProfile()]);
  return { shortcuts, logins: profile.logins, startups: profile.startups, notes: profile.notes };
}

// Save a partial update (only the provided sections change). Shortcuts are NOT
// saved here — they have their own endpoint (/api/shortcuts).
export async function saveMemory(input: {
  logins?: unknown;
  startups?: unknown;
  notes?: unknown;
}): Promise<Memory> {
  const cur = await readProfile();
  const next: StoredProfile = {
    logins: input.logins !== undefined ? sanitizeLogins(input.logins) : cur.logins,
    startups: input.startups !== undefined ? sanitizeStartups(input.startups) : cur.startups,
    notes: input.notes !== undefined ? str(input.notes) : cur.notes,
  };
  await writeProfile(next);
  return getMemory();
}

// Render the "# About me" markdown block injected into every turn. Empty sections
// are omitted so the prompt stays lean. Always returns at least the heading.
export function renderMemoryMarkdown(mem: Memory): string {
  const parts: string[] = ["# About me (memory)"];

  if (mem.notes.trim()) {
    parts.push(`## Notes about me\n${mem.notes.trim()}`);
  }
  if (mem.shortcuts.length) {
    parts.push(
      "## Website shortcuts (open these by name)\n" +
        "When I ask to open/show something that matches one of these names (e.g. my " +
        "usage dashboard, my email, a site I named), this list WINS — open the URL " +
        "below with browser_open instead of guessing a site or treating it as an app. " +
        "Match loosely on meaning, not exact words.\n" +
        mem.shortcuts.map((s) => `- ${s.keyword} → ${s.url}`).join("\n")
    );
  }
  if (mem.logins.length) {
    parts.push(
      "## Logins (use when a site needs me to sign in)\n" +
        mem.logins
          .map((l) => {
            const creds = [l.username && `user ${l.username}`, l.password && `pass ${l.password}`]
              .filter(Boolean)
              .join(" · ");
            return `- ${l.host}${creds ? ` → ${creds}` : ""}`;
          })
          .join("\n")
    );
  }
  if (mem.startups.length) {
    parts.push(
      "## Startup steps (do these right after I open a site in the browser)\n" +
        mem.startups.map((s) => `- ${s.url} → ${s.command}`).join("\n")
    );
  }

  return parts.join("\n\n");
}
