// Unified activity log — the single source for "what the assistant did" and for
// short-term recall, on BOTH the cloud and local paths. Backed by its own
// `activity` table (not a mail_kv namespace) so it's clearly separated from
// settings/state/cooldowns. Each row is one assistant turn: the user's message,
// the tools/decisions the model ran, and the spoken reply.
//
//   • recordActivity()        — append one turn (cloud loop + local memory route)
//   • getRecentActivityBlock()— inject the last few turns into the next prompt
//   • getActivity()/clear     — power the Activity card (view + clear)
//
// Replaces the old lib/continuity.ts (cloud_convo mail_kv namespace). Best-effort:
// a DB failure never breaks a turn (the reply is already produced when this runs).

import { desc, lt } from "drizzle-orm";
import { db, activity } from "@/db";

const RECALL_TURNS = 5; // recent turns injected into each prompt for continuity
const KEEP_ROWS = 500; // prune the table to this many newest rows

export type ActivityAction = { name: string; args?: unknown };

export type RecordActivityInput = {
  source?: "cloud" | "local";
  user: string;
  reply: string;
  model?: string | null;
  actions?: ActivityAction[];
};

// Append one turn. Skips empty turns (no user text and no reply). Prunes old rows
// occasionally so the table stays bounded without a cron.
export async function recordActivity(input: RecordActivityInput): Promise<void> {
  const user = String(input.user ?? "").trim();
  const reply = String(input.reply ?? "").trim();
  if (!user && !reply) return;
  const actions = Array.isArray(input.actions) ? input.actions : [];
  const tools = actions.map((a) => String(a?.name ?? "")).filter(Boolean);
  try {
    const [row] = await db
      .insert(activity)
      .values({
        source: input.source === "local" ? "local" : "cloud",
        userText: user.slice(0, 2000),
        reply: reply.slice(0, 4000),
        model: input.model ? String(input.model).slice(0, 120) : null,
        tools,
        decisions: actions.map((a) => ({ name: String(a?.name ?? ""), args: a?.args })),
      })
      .returning({ id: activity.id });
    // Prune past the newest KEEP_ROWS, cheaply (only every ~25 inserts).
    if (row?.id && row.id % 25 === 0) {
      const cutoff = await db
        .select({ id: activity.id })
        .from(activity)
        .orderBy(desc(activity.id))
        .limit(1)
        .offset(KEEP_ROWS);
      if (cutoff[0]?.id) await db.delete(activity).where(lt(activity.id, cutoff[0].id));
    }
  } catch {
    /* best-effort */
  }
}

// The last `n` turns as a compact prompt block, oldest→newest, or "" if none.
// Includes the tools used so the model knows not just what was said but what it
// actually did last turn.
export async function getRecentActivityBlock(n = RECALL_TURNS): Promise<string> {
  try {
    const rows = await db
      .select({
        userText: activity.userText,
        reply: activity.reply,
        tools: activity.tools,
      })
      .from(activity)
      .orderBy(desc(activity.id))
      .limit(n);
    if (!rows.length) return "";
    const lines = rows
      .reverse() // oldest→newest
      .map((t) => {
        const tools = Array.isArray(t.tools) && t.tools.length ? ` [tools: ${t.tools.join(", ")}]` : "";
        return `- User: "${t.userText}" → You: "${t.reply}"${tools}`;
      })
      .join("\n");
    return `## Recent activity (your last ${rows.length} turns)\n${lines}`;
  } catch {
    return "";
  }
}

export type ActivityListRow = {
  id: number;
  at: string;
  source: string;
  user: string;
  reply: string;
  model: string | null;
  tools: string[];
  decisions: ActivityAction[];
};

// Newest-first list for the Activity card.
export async function getActivity(limit = 100): Promise<ActivityListRow[]> {
  try {
    const rows = await db
      .select()
      .from(activity)
      .orderBy(desc(activity.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      at: r.at instanceof Date ? r.at.toISOString() : String(r.at),
      source: r.source,
      user: r.userText,
      reply: r.reply,
      model: r.model,
      tools: Array.isArray(r.tools) ? r.tools : [],
      decisions: Array.isArray(r.decisions) ? r.decisions : [],
    }));
  } catch {
    return [];
  }
}

// Wipe the whole activity log (the card's Clear button). Returns ok so the UI can
// report success/failure.
export async function clearActivity(): Promise<boolean> {
  try {
    await db.delete(activity);
    return true;
  } catch {
    return false;
  }
}
