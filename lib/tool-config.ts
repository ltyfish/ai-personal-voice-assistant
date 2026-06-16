"use client";

// LOCAL toolset configuration (client-side only).
//
// The LOCAL voice path runs JARVIS's OWN native tool loop (no Hermes): the
// browser asks /api/agent/prep for the routed prompt + tool defs, runs the
// tool-calling loop against the native router (/api/v1), and dispatches each
// call (browser tools → the localhost bridge, everything else → /api/agent/tool).
//
// This module is the single source of truth for WHICH native tools the local
// loop may use, grouped so the user can check/uncheck a whole capability at once
// (e.g. "Browser tools" holds all browser_* functions). Only ENABLED groups'
// tools are put into the schema handed to the model. The selection is the user's,
// persisted in localStorage; it is LOCAL-only and never touches the cloud path.

export type LocalToolGroup = {
  key: string;
  label: string;
  hint: string;
  tools: string[]; // tool names, must match lib/tools.ts toolDefs
};

// Groups mirror the function names in lib/tools.ts `toolDefs`. Keep in sync if a
// tool is renamed/added there.
export const LOCAL_TOOL_GROUPS: LocalToolGroup[] = [
  {
    key: "tasks",
    label: "Tasks",
    hint: "Create, list, update, complete and delete to-dos and their subtasks.",
    tools: [
      "create_task", "update_task", "delete_task", "complete_all", "list_tasks",
      "add_subtask", "update_subtask", "delete_subtask", "list_subtasks",
    ],
  },
  {
    key: "events",
    label: "Calendar",
    hint: "Create, list, reschedule and delete calendar events.",
    tools: ["create_event", "update_event", "delete_event", "list_events"],
  },
  {
    key: "notes",
    label: "Notes",
    hint: "Save, search, edit and delete notes.",
    tools: ["create_note", "search_notes", "update_note", "delete_note"],
  },
  {
    key: "projects",
    label: "Projects",
    hint: "Project cards, improvement notes and scheduled project time.",
    tools: ["create_project", "list_projects", "update_project", "delete_project", "project_time"],
  },
  {
    key: "bulk",
    label: "Bulk wipe",
    hint: "Delete ALL items of a kind at once.",
    tools: ["delete_all"],
  },
  {
    key: "email",
    label: "Email",
    hint: "Read, fetch and mark MailMind email summaries.",
    tools: ["list_emails", "mark_emails_reviewed", "fetch_emails_now"],
  },
  {
    key: "spotify",
    label: "Spotify",
    hint: "Play, queue and control Spotify playback.",
    tools: ["play_spotify", "queue_spotify", "spotify_control"],
  },
  {
    key: "browser",
    label: "Browser tools",
    hint: "Drive your logged-in browser: open, snapshot, click/type, read.",
    tools: ["browser_open", "browser_snapshot", "browser_scroll", "browser_act", "browser_read"],
  },
  {
    key: "apps",
    label: "Apps & folders",
    hint: "Open an app or folder on your computer (URLs go to the browser tools).",
    tools: ["open_app"],
  },
  {
    key: "shell",
    label: "PowerShell",
    hint: "Developer mode: run a reviewed PowerShell command.",
    tools: ["run_shell"],
  },
  {
    key: "messaging",
    label: "Messaging & contacts",
    hint: "Send WhatsApp/Telegram/email and manage contacts.",
    tools: ["send_message", "add_contact", "list_contacts", "sync_contacts"],
  },
  {
    key: "github",
    label: "GitHub & health",
    hint: "List/review PRs, repo CI status, and run project health checks.",
    tools: ["github_prs", "github_status", "github_pr_review", "health_status"],
  },
];

const DISABLED_KEY = "local.tools.disabled";

// Which group keys the user has turned OFF (default: none — all enabled).
export function getDisabledGroups(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch {
    return new Set();
  }
}

export function isGroupEnabled(key: string): boolean {
  return !getDisabledGroups().has(key);
}

export function setGroupEnabled(key: string, enabled: boolean) {
  if (typeof window === "undefined") return;
  const disabled = getDisabledGroups();
  if (enabled) disabled.delete(key);
  else disabled.add(key);
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...disabled]));
  } catch {
    /* best-effort */
  }
}

// The flat list of tool names the local loop may use right now (union of every
// enabled group). Handed to /api/agent/prep so only these enter the schema.
export function getEnabledLocalToolNames(): string[] {
  const disabled = getDisabledGroups();
  const out: string[] = [];
  for (const g of LOCAL_TOOL_GROUPS) {
    if (!disabled.has(g.key)) out.push(...g.tools);
  }
  return out;
}
