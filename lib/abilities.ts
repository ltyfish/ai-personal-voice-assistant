// ── Ability registry (domain groups + action verbs) ─────────────────────────
// Each ABILITY is a DOMAIN (a thing: Tasks, Events, Notes, Email, Music…). Its
// functions are the VERBS you can do to it (add, list, complete, edit, delete).
//
// Routing (resolveWords), ONE rule:
//   1. SELECT the domain: scan the sentence left-to-right; the first word that is
//      a domain's keyword AND is NOT a generic action verb picks the domain. So a
//      noun ("task", "event", "contacts") or a domain-specific word ("schedule",
//      "play", "email") selects; bare verbs ("add", "list", "delete") do NOT —
//      that's why "add task" and "add event" never collide (the NOUN decides).
//   2. PICK the verb: inside that domain, the earliest function keyword (verbs
//      included) chooses the tool. If several things are asked, join with "and".
//   3. Only a domain word, no verb (and the domain has >1 verb) → ask which one.
//      Domain word for a single-verb domain → just run it. No keyword → chat.
//   • BULK: each card has delete_all/complete_all rows (bulk: true). "<verb>
//     all/everything <noun>" (or "wipe <noun>") wipes/completes that card only,
//     with an EXPLICIT target set by routing (resolveBulk) — never the LLM. A bare
//     cross-domain command with no noun ("delete everything", "wipe everything",
//     "complete everything") acts on tasks + events + notes at once (bareBulk).
//
// PURE DATA (no server/db imports) so the client Abilities tab can import it.
// Custom overrides (group + per-function) live in mail_kv (lib/keywords).

export type AbilityGroup =
  | "email"
  | "spotify"
  | "local"
  | "shell"
  | "search"
  | "message";

export type AbilityFunction = {
  tool: string; // the tool this verb calls (one function per tool)
  label: string; // UI label
  defaultKeywords: string[]; // words that select THIS verb inside the domain
  /** A bulk row (delete_all/complete_all) scoped to this card's domain. Fires on
   *  "<verb> all/everything <noun>" (or a bulk-only word like "wipe"); the LLM is
   *  never asked to pick the target — routing sets it from the card. */
  bulk?: boolean;
};

export type Ability = {
  id: string;
  label: string;
  icon: string;
  blurb: string;
  section: string;
  group?: AbilityGroup; // domain rule block (omit for core task/event/note tools)
  needsSnapshot?: boolean; // lists/edits/deletes need the current-data snapshot
  /** domain words that name the thing (these SELECT the domain) */
  defaultGroupKeywords: string[];
  /** Curated generic verbs this card claims as a STANDALONE trigger ("new"/
   *  "recent" => email fetch), used only as a last resort when no ordinary card
   *  word was said — so "new task" still makes a task. Built-in only (not user
   *  overrides, which stay generic). */
  shortcutKeywords?: string[];
  functions: AbilityFunction[];
  examples: string[];
};

// Generic action verbs. They pick the VERB inside a domain but never SELECT a
// domain on their own — so "add task" vs "add event" is decided by the noun, not
// by "add". (A word here can still be a function keyword; it just can't select.)
export const ACTION_WORDS = new Set<string>([
  "add", "create", "new", "make",
  "list", "show", "view", "see", "read", "summary", "summarize",
  "done", "complete", "completed", "finish", "finished", "mark", "check",
  "undo", "reopen",
  "change", "edit", "update", "rename", "schedule", "reschedule", "move", "set", "priority",
  "delete", "remove", "clear", "wipe", "cancel",
  "all",
]);

/** Does this keyword select a domain (true), or is it a generic action verb?
 *  A keyword selects only if NONE of its words is a generic action verb — so a
 *  multi-word bulk keyword like "delete all" stays an action (it can't select a
 *  card), while real nouns/shortcuts ("schedule", "recent") still select. */
export function selectsDomain(keyword: string): boolean {
  return keyword
    .toLowerCase()
    .split(/\s+/)
    .every((w) => w.length > 0 && !ACTION_WORDS.has(w));
}

// Order matters: ties at the same word position break by this order.
export const ABILITIES: Ability[] = [
  {
    id: "tasks",
    label: "Tasks",
    icon: "✓",
    blurb: "Your to-do items. Say a verb + “task” — add, list, complete, edit, delete.",
    section: "Tasks",
    needsSnapshot: true,
    defaultGroupKeywords: ["task", "tasks"],
    functions: [
      { tool: "create_task", label: "Add task", defaultKeywords: ["add", "create", "new", "make", "todo", "to-do", "schedule"] },
      { tool: "list_tasks", label: "List tasks", defaultKeywords: ["list", "show", "view"] },
      {
        tool: "update_task",
        label: "Complete / edit",
        defaultKeywords: [
          "done", "complete", "finish", "mark", "check", "undo", "reopen",
          "change", "edit", "update", "reschedule", "move", "rename",
          "priority", "prioritize", "prioritise", "reprioritize", "reprioritise", "set",
        ],
      },
      { tool: "delete_task", label: "Delete task", defaultKeywords: ["delete", "remove", "clear"] },
      // BULK rows: fire on "<verb> all/everything tasks" (or "wipe tasks"). The
      // single rows above win plain "delete task 3"; "all"/"everything"/"wipe"
      // scales it to every task. Editable here.
      { tool: "complete_all", label: "Complete all tasks", bulk: true, defaultKeywords: ["complete all", "done all", "finish all", "mark all", "complete everything", "done everything"] },
      { tool: "delete_all", label: "Delete all / wipe tasks", bulk: true, defaultKeywords: ["delete all", "remove all", "clear all", "wipe", "delete everything"] },
    ],
    examples: ["add task call the dentist", "list my tasks", "done task 3", "delete all tasks"],
  },
  {
    id: "remind",
    label: "Reminder",
    icon: "🔔",
    blurb: "A due-dated task that alerts you before it's due.",
    section: "Tasks",
    needsSnapshot: false,
    defaultGroupKeywords: [],
    functions: [
      { tool: "create_task", label: "Set reminder", defaultKeywords: ["remind", "reminder"] },
    ],
    examples: ["remind me to pay rent on Friday", "reminder to call mom at 6pm"],
  },
  {
    id: "events",
    label: "Calendar events",
    icon: "◷",
    blurb: "Timed events (supports repeats). Verb + “event” — add, list, reschedule, delete.",
    section: "Calendar",
    needsSnapshot: true,
    // "meeting"/"appointment" name an event, so they SELECT the domain. "schedule"
    // is a generic verb (it's in ACTION_WORDS — tasks/projects schedule too), so it
    // can't select on its own; the shortcut below keeps a bare "schedule X" (no
    // noun) creating an event, while "schedule … project" still routes to Projects.
    defaultGroupKeywords: ["event", "events", "calendar", "meeting", "appointment"],
    shortcutKeywords: ["schedule"],
    functions: [
      { tool: "create_event", label: "Add event", defaultKeywords: ["add", "create", "new", "schedule", "meeting", "appointment"] },
      { tool: "list_events", label: "List events", defaultKeywords: ["list", "show", "view"] },
      {
        tool: "update_event",
        label: "Complete / reschedule",
        defaultKeywords: ["done", "complete", "finish", "mark", "undo", "reopen", "change", "edit", "update", "reschedule", "move"],
      },
      { tool: "delete_event", label: "Delete event", defaultKeywords: ["delete", "remove", "clear"] },
      // BULK rows: "<verb> all/everything events" / "wipe events" → every event.
      { tool: "complete_all", label: "Complete all events", bulk: true, defaultKeywords: ["complete all", "done all", "finish all", "mark all", "complete everything", "done everything"] },
      { tool: "delete_all", label: "Delete all / wipe events", bulk: true, defaultKeywords: ["delete all", "remove all", "clear all", "wipe", "delete everything"] },
    ],
    examples: ["schedule gym tomorrow at 7pm", "list events on Saturday", "move the meeting to Friday"],
  },
  {
    id: "notes",
    label: "Notes",
    icon: "✎",
    blurb: "Quick memos. Verb + “note” — add, list/search, edit, delete.",
    section: "Notes",
    needsSnapshot: true,
    defaultGroupKeywords: ["note", "notes", "memo"],
    functions: [
      { tool: "create_note", label: "Add note", defaultKeywords: ["add", "create", "new", "make"] },
      { tool: "search_notes", label: "List / search notes", defaultKeywords: ["list", "show", "view", "find"] },
      { tool: "update_note", label: "Edit note", defaultKeywords: ["change", "edit", "update", "rename"] },
      { tool: "delete_note", label: "Delete note", defaultKeywords: ["delete", "remove", "clear"] },
      // BULK row: "<verb> all/everything notes" / "wipe notes" → every note.
      // (Notes have no complete state, so no "Complete all" row.)
      { tool: "delete_all", label: "Delete all / wipe notes", bulk: true, defaultKeywords: ["delete all", "remove all", "clear all", "wipe", "delete everything"] },
    ],
    examples: ["add note the wifi password is hunter2", "list my notes", "delete note 3"],
  },
  {
    id: "projects",
    label: "Projects",
    icon: "🗂",
    blurb: "Project cards you collect improvements on. Verb + “project” — add, list/summarize, edit, schedule time, delete.",
    section: "Projects",
    needsSnapshot: true,
    defaultGroupKeywords: ["project", "projects"],
    functions: [
      { tool: "create_project", label: "Add project", defaultKeywords: ["create", "new", "make", "start"] },
      { tool: "list_projects", label: "List / read / summarize", defaultKeywords: ["list", "show", "view", "read", "summarize", "summary"] },
      {
        tool: "update_project",
        label: "Complete / edit / add improvement",
        defaultKeywords: ["done", "complete", "finish", "mark", "undo", "reopen", "change", "edit", "update", "rename", "improvement", "improvements", "improve", "idea"],
      },
      { tool: "project_time", label: "Add / reschedule / cancel time", defaultKeywords: ["time", "block", "schedule"] },
      { tool: "delete_project", label: "Delete project", defaultKeywords: ["delete", "remove", "clear"] },
      // BULK rows: "<verb> all/everything projects" / "wipe projects" → every project.
      { tool: "complete_all", label: "Complete all projects", bulk: true, defaultKeywords: ["complete all", "done all", "finish all", "mark all", "complete everything", "done everything"] },
      { tool: "delete_all", label: "Delete all / wipe projects", bulk: true, defaultKeywords: ["delete all", "remove all", "clear all", "wipe", "delete everything"] },
    ],
    examples: ["create a project for the website redesign", "add improvement to project 2 use a faster cache", "complete project 1", "delete all projects"],
  },
  {
    id: "email",
    label: "Email digest",
    icon: "✉",
    blurb: "Your connected Gmail, summarized.",
    section: "Email",
    group: "email",
    defaultGroupKeywords: ["email", "emails", "mail", "gmail", "inbox"],
    // "new"/"recent" select email on their own (say them without "emails") and
    // mean "what's arrived since the last fetch" (fetch_emails_now), distinct from
    // "digest"/"summary" which fetch + read today's whole inbox (list_emails).
    shortcutKeywords: ["new", "recent"],
    functions: [
      {
        tool: "list_emails",
        label: "Read summaries",
        defaultKeywords: ["digest", "unread", "urgent", "newsletter", "sender", "summary", "summarize", "latest"],
      },
      { tool: "fetch_emails_now", label: "Fetch new / recent", defaultKeywords: ["fetch", "refresh", "new", "recent"] },
      { tool: "mark_emails_reviewed", label: "Mark reviewed", defaultKeywords: ["reviewed", "review"] },
    ],
    examples: ["email digest", "what's new", "fetch my email", "email mark all reviewed"],
  },
  {
    id: "music",
    label: "Music",
    icon: "♪",
    blurb: "Play and control Spotify (Premium).",
    section: "Music",
    group: "spotify",
    defaultGroupKeywords: ["spotify", "music"],
    functions: [
      {
        tool: "play_spotify",
        label: "Play",
        defaultKeywords: ["play", "song", "songs", "artist", "album", "playlist"],
      },
      { tool: "queue_spotify", label: "Queue", defaultKeywords: ["queue"] },
      {
        tool: "spotify_control",
        label: "Control (pause/skip/volume…)",
        defaultKeywords: [
          "pause", "resume", "skip", "next", "previous", "volume", "louder",
          "quieter", "mute", "shuffle", "repeat", "playing", "save", "like",
        ],
      },
    ],
    examples: ["play Bohemian Rhapsody", "queue Levitating", "pause / skip / louder"],
  },
  {
    // Public page reading is CLOUD-only: read_site fetches + summarizes a public
    // page without opening the user's logged-in local browser.
    id: "open",
    label: "Read / summarize a page",
    icon: "▦",
    blurb: "Read or summarize a public web page aloud (no browser opened).",
    section: "Web",
    group: "search",
    defaultGroupKeywords: [],
    functions: [
      { tool: "read_site", label: "Read / summarize a page", defaultKeywords: ["summarize", "summarise", "read"] },
    ],
    examples: ["summarize deployment", "read me espn.com", "what does wikipedia.org/jarvis say"],
  },
  {
    id: "run",
    label: "Run a command",
    icon: "⌘",
    blurb: "Developer mode — run a PowerShell command you confirm.",
    section: "Computer",
    group: "shell",
    defaultGroupKeywords: [],
    functions: [
      {
        tool: "run_shell",
        label: "Run command",
        defaultKeywords: ["run", "execute", "powershell", "terminal", "shell", "cmdlet", "script"],
      },
    ],
    examples: ["run get-date", "execute the top 5 processes by CPU"],
  },
  {
    id: "contacts",
    label: "Contacts",
    icon: "👤",
    blurb: "Your contacts book. Verb + “contact(s)” — add, list, sync.",
    section: "People",
    group: "message",
    defaultGroupKeywords: ["contact", "contacts"],
    functions: [
      { tool: "add_contact", label: "Add contact", defaultKeywords: ["add", "create", "new"] },
      { tool: "list_contacts", label: "List contacts", defaultKeywords: ["list", "show"] },
      // "google"/"telegram" omitted on purpose — they clash with web search and
      // messaging. Say "sync"/"import" ("sync google contacts").
      { tool: "sync_contacts", label: "Sync / import", defaultKeywords: ["sync", "import"] },
    ],
    examples: ["add contact Alex telegram @alex", "list contacts", "sync google contacts"],
  },
  {
    id: "message",
    label: "Message someone",
    icon: "💬",
    blurb: "Text someone for free (WhatsApp / Telegram / email).",
    section: "People",
    group: "message",
    defaultGroupKeywords: [],
    functions: [
      {
        tool: "send_message",
        label: "Send message",
        defaultKeywords: ["message", "messages", "text", "whatsapp", "telegram", "dm", "msg"],
      },
    ],
    examples: ["message Mom I'll be home by 8", "text Alex the meeting moved"],
  },
];

// id -> { group?: custom group words; fns?: { toolName: custom function words };
//         priority?: lower wins a shared keyword (default = registry order) }
export type AbilityOverride = { group?: string[]; fns?: Record<string, string[]>; priority?: number };
export type KeywordMap = Record<string, AbilityOverride>;

// Abilities in resolution order: those the user gave an explicit PRIORITY come
// first (ascending — 1 wins), the rest keep registry order. Used so that when two
// cards share a domain-selecting keyword, the higher-priority card wins the tie.
export function orderedAbilities(map: KeywordMap = {}): Ability[] {
  return ABILITIES.map((a, i) => ({ a, i, p: map[a.id]?.priority }))
    .sort((x, y) => {
      const px = x.p == null ? Infinity : x.p;
      const py = y.p == null ? Infinity : y.p;
      return px !== py ? px - py : x.i - y.i;
    })
    .map((x) => x.a);
}

export function abilityTools(a: Ability): string[] {
  return a.functions.map((f) => f.tool);
}

function clean(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const raw of list) {
    const kw = String(raw ?? "").trim().toLowerCase();
    if (kw && !out.includes(kw)) out.push(kw);
  }
  return out;
}

/** Group-level keywords in effect (custom override or defaults). */
export function effectiveGroupKeywords(a: Ability, map: KeywordMap = {}): string[] {
  const custom = clean(map[a.id]?.group);
  return custom.length ? custom : a.defaultGroupKeywords.map((k) => k.toLowerCase());
}

/** Function-level keywords in effect for one verb-function. */
export function effectiveFunctionKeywords(
  a: Ability,
  f: AbilityFunction,
  map: KeywordMap = {}
): string[] {
  const custom = clean(map[a.id]?.fns?.[f.tool]);
  return custom.length ? custom : f.defaultKeywords.map((k) => k.toLowerCase());
}

function tokenize(text: string): string[] {
  return (text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchAt(words: string[], i: number, parts: string[]): boolean {
  if (!parts.length || i + parts.length > words.length) return false;
  return parts.every((p, k) => words[i + k] === p);
}

// Earliest position where keyword `kw` (single or multi-word) appears, or -1.
function earliestPos(words: string[], kw: string): number {
  const parts = tokenize(kw);
  for (let i = 0; i < words.length; i++) if (matchAt(words, i, parts)) return i;
  return -1;
}
