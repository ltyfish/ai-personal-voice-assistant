import { and, asc, desc, eq, gte, lte, ilike, or } from "drizzle-orm";
import { db, tasks, events, notes, projects } from "@/db";
import { expandEvents } from "./recur";
import { parseRef, refOf } from "./refs";
import { listSummaries, setSummary, localDateKey } from "@/lib/mail/blobs";
import { runFetch } from "@/lib/mail/fetch";
import type { Summary } from "@/lib/mail/types";
import { resolveUrl, knownSiteUrl } from "@/lib/local";
import { readPage } from "@/lib/webread";
import * as spotify from "@/lib/spotify";
import { sendMessage, type Channel } from "@/lib/messaging";
import { listContacts, upsertContact, deleteContact } from "@/lib/contacts";
import { importGoogleContacts, createGoogleContact } from "@/lib/google-contacts";
import { isTelegramUserConfigured, importTelegramContacts } from "@/lib/telegram-user";

// JSON-schema tool definitions handed to the Groq LLM.
export const toolDefs = [
  {
    type: "function" as const,
    function: {
      name: "create_task",
      description: "Create a to-do task. Use for things the user needs to DO (not timed calendar events).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          notes: { type: ["string", "null"] },
          priority: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
          due_date: { type: ["string", "null"], description: "ISO 8601 datetime with timezone offset, or null" },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_task",
      description: "Update a task. Prefer the short ref (e.g. 'Task 3') from CURRENT data; falls back to title match. Use to mark done, reschedule, or change priority.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Task 3' for the exact task" },
          title: { type: "string", description: "title text to match the task by (when no ref)" },
          notes: { type: ["string", "null"] },
          done: { type: "boolean" },
          priority: { type: ["string", "null"], enum: ["low", "medium", "high", null] },
          due_date: { type: ["string", "null"], description: "ISO 8601 datetime, or null to clear" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_task",
      description: "Delete a task. Prefer the short ref (e.g. 'Task 3') from CURRENT data; falls back to title match.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Task 3'" },
          title: { type: "string", description: "title text to match (when no ref)" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "complete_all",
      description: "Mark ALL open tasks, events, and/or projects as complete at once (moves them to History). Use for 'mark everything complete', 'complete all tasks', 'mark all events done', 'complete all projects'.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["tasks", "events", "projects", "all"],
            description: "which items to complete; 'all' = tasks, events AND projects",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_tasks",
      description: "List tasks. Optionally filter to only open (not done) tasks.",
      parameters: {
        type: "object",
        properties: { only_open: { type: "boolean" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_event",
      description: "Create a timed calendar event. Supports recurrence for things like 'every Monday' (weekly), 'every day' (daily), or 'monthly'.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          location: { type: ["string", "null"] },
          start_time: { type: "string", description: "ISO 8601 datetime with timezone offset (first occurrence)" },
          end_time: { type: "string", description: "ISO 8601 datetime with timezone offset" },
          recurrence: {
            type: "string",
            enum: ["none", "daily", "weekly", "monthly"],
            description: "Repeat rule. 'every Monday' => weekly with start_time on a Monday.",
          },
          recurrence_end: { type: ["string", "null"], description: "ISO 8601 date to stop repeating, or null for ongoing" },
        },
        required: ["title", "start_time", "end_time"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_event",
      description: "Update/reschedule an event. Prefer the short ref (e.g. 'Event 2') from CURRENT data; falls back to title match. Set done=true to mark it complete (moves it to History).",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Event 2' for the exact event" },
          title: { type: "string", description: "title text to match the event by (when no ref)" },
          location: { type: ["string", "null"] },
          done: { type: "boolean", description: "mark the event complete" },
          start_time: { type: "string", description: "new ISO 8601 start" },
          end_time: { type: "string", description: "new ISO 8601 end" },
          recurrence: { type: "string", enum: ["none", "daily", "weekly", "monthly"] },
          recurrence_end: { type: ["string", "null"], description: "ISO 8601 or null" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_event",
      description: "Delete a calendar event. Prefer the short ref (e.g. 'Event 2') from CURRENT data; falls back to title match.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Event 2'" },
          title: { type: "string", description: "title text to match (when no ref)" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_events",
      description: "List calendar events between two datetimes (inclusive). Use for 'what's today', 'what's next', 'this week'.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "ISO 8601 start of range" },
          to: { type: "string", description: "ISO 8601 end of range" },
        },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_note",
      description: "Save a note / memo.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search_notes",
      description: "Search notes by keyword. Empty query returns recent notes.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_note",
      description: "Update/replace a note's text. The note's visible content is its BODY, so put the new wording in `body` (e.g. 'update Note 4 to buy milk' => body='buy milk'). Only set `title` if the user explicitly mentions a title. Prefer the short ref (e.g. 'Note 4') from CURRENT data; falls back to matching the note's text.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Note 4' for the exact note" },
          query: { type: "string", description: "text to match the note by (when no ref)" },
          body: { type: "string", description: "the note's new full text (use this for 'change/update note to ...')" },
          title: { type: ["string", "null"], description: "ONLY when the user explicitly says 'title'; otherwise omit" },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_note",
      description: "Delete a note. Prefer the short ref (e.g. 'Note 4') from CURRENT data; falls back to matching the note's text.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Note 4'" },
          query: { type: "string", description: "text to match the note by (when no ref)" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_all",
      description:
        "Delete ALL items of a kind at once: for 'delete all events', 'delete all my tasks', 'clear all notes', 'delete everything'. Deletes items whether or not they are completed/marked. Optionally limit to only completed or only open items.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            enum: ["tasks", "events", "notes", "projects", "all"],
            description: "which kind to wipe; 'all' = tasks, events, notes AND projects",
          },
          status: {
            type: ["string", "null"],
            enum: ["all", "completed", "open", null],
            description:
              "which to delete: 'all' (default — regardless of completion), 'completed' only ('delete all done events'), or 'open' only. Notes have no status, so this only narrows tasks/events/projects.",
          },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_project",
      description:
        "Create a PROJECT — a card the user collects improvements/ideas on over time (e.g. 'create a project for the website redesign'). Optionally seed it with a first improvement note.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "the project's name" },
          improvement: {
            type: ["string", "null"],
            description: "an optional first improvement/idea to add to the project",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_projects",
      description:
        "List the user's projects and their improvement notes. Use to READ, SUMMARIZE, or report a single project or ALL projects ('what are my projects', 'summarize the website project', 'read project 2').",
      parameters: {
        type: "object",
        properties: {
          ref: {
            type: ["string", "null"],
            description: "short ref like 'Project 2' to read ONE project; omit for all",
          },
          title: {
            type: ["string", "null"],
            description: "project name to match when reading one (when no ref)",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_project",
      description:
        "Update a project: rename it, ADD an improvement note, EDIT an existing improvement, or REMOVE one. Prefer the short ref (e.g. 'Project 2') from CURRENT data; falls back to title match. Improvements are listed with a 1-based number in the snapshot — use that for edit/remove.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Project 2'" },
          title: { type: "string", description: "project name to match (when no ref)" },
          new_title: { type: ["string", "null"], description: "rename the project to this" },
          done: { type: ["boolean", "null"], description: "true to mark the project complete (moves it to History), false to reopen it" },
          add_improvement: {
            type: ["string", "null"],
            description: "an improvement/idea to append to the project",
          },
          edit_improvement_number: {
            type: ["number", "null"],
            description: "1-based number of the improvement to rewrite",
          },
          edit_improvement_text: {
            type: ["string", "null"],
            description: "new text for the improvement named by edit_improvement_number",
          },
          remove_improvement_number: {
            type: ["number", "null"],
            description: "1-based number of the improvement to delete",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "delete_project",
      description:
        "Delete a whole project (and any calendar time scheduled for it). Prefer the short ref (e.g. 'Project 2') from CURRENT data; falls back to title match.",
      parameters: {
        type: "object",
        properties: {
          ref: { type: ["string", "null"], description: "short ref like 'Project 2'" },
          title: { type: "string", description: "project name to match (when no ref)" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "project_time",
      description:
        "Add, reschedule, or cancel a project's scheduled TIME on the calendar (a 'project event', shown with a project icon). action 'add' creates a new time; 'reschedule' moves an existing one; 'cancel' removes one. Examples: 'add time to the website project tomorrow 3pm' (add), 'move project 2's time to Friday 4pm' (reschedule), 'cancel the voice cloning project time' (cancel). Prefer the project's ref from CURRENT data.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add", "reschedule", "cancel"],
            description: "what to do with the project's time",
          },
          ref: { type: ["string", "null"], description: "the project's short ref like 'Project 2'" },
          title: { type: "string", description: "project name to match (when no ref)" },
          event_ref: {
            type: ["string", "null"],
            description:
              "which scheduled time to change, e.g. 'Event 15' from CURRENT data (shown as 'time for Project N'). Needed for reschedule/cancel only when the project has MORE THAN ONE time; omit if it has just one.",
          },
          start_time: { type: ["string", "null"], description: "ISO 8601 datetime with offset (add/reschedule)" },
          end_time: { type: ["string", "null"], description: "OPTIONAL ISO 8601 end. Omit it if the user only gave a start time — it defaults to one hour after start (or keeps the existing length when rescheduling)." },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_emails",
      description:
        "Read email summaries (connected Gmail via MailMind). For 'email summary/digest', 'urgent emails', 'latest email', or mail from a sender (e.g. 'emails from KrisFlyer').",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: ["string", "null"],
            description:
              "sender name, company, or keyword to match in the sender or subject (e.g. 'krisflyer')",
          },
          min_urgency: {
            type: ["number", "null"],
            description:
              "only return emails with urgency >= this. Use 4 for 'urgent emails'.",
          },
          unreviewed_only: {
            type: ["boolean", "null"],
            description: "only emails not yet marked reviewed",
          },
          limit: {
            type: ["number", "null"],
            description: "max emails to return; use 1 for a single email",
          },
          order: {
            type: ["string", "null"],
            enum: ["urgent", "recent", null],
            description:
              "sort order. 'urgent' (default) = highest urgency first; 'recent' = newest received first. Use 'recent' with limit=1 for 'the most recent / latest fetched email'.",
          },
          today_only: {
            type: ["boolean", "null"],
            description:
              "true to only include TODAY's emails (matches the Digest tab). Use for 'what's my digest', 'today's emails', 'recent emails'. Omit/false to search all stored emails (e.g. a sender lookup).",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "mark_emails_reviewed",
      description:
        "Mark emails reviewed/un-reviewed: all=true for 'mark all reviewed', or query=sender/keyword for specific ones.",
      parameters: {
        type: "object",
        properties: {
          all: {
            type: ["boolean", "null"],
            description: "true to mark every email reviewed",
          },
          query: {
            type: ["string", "null"],
            description: "sender/company/keyword to match the emails to mark",
          },
          reviewed: {
            type: ["boolean", "null"],
            description: "true to mark reviewed (default), false to un-review",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_emails_now",
      description:
        "Poll Gmail now for NEW emails and summarize them. For 'fetch/check my email now', 'any new emails'. Returns only mail since the last fetch.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_site",
      description:
        "READ or SUMMARIZE the CONTENT of a web page (does NOT open the browser — it fetches the page text and reads it back). Use for 'summarize <site>', 'read me <site>', 'what does <site> say'. `site` is a full https URL or a known site name. Set mode='summarize' for a short summary, mode='read' to read the main content back.",
      parameters: {
        type: "object",
        properties: {
          site: {
            type: "string",
            description: "a full https URL or a known site name to read/summarize",
          },
          mode: {
            type: "string",
            enum: ["summarize", "read"],
            description: "'summarize' for a brief summary (default), 'read' to read the main content back",
          },
        },
        required: ["site"],
      },
    },
  },
  // ── Controlled-browser AGENTIC tools (local model only) ──────────────────
  // These drive the user's REAL, logged-in Chromium via the local bridge. They
  // are executed CLIENT-SIDE (lib/local-agent.ts dispatches them to the bridge);
  // the cloud server can't reach localhost, so runTool short-circuits them with a
  // "runs locally" note and they are never routed to a cloud model. The local
  // model chains them freely: snapshot to see the page, act on a [ref], read to
  // answer. This is what lets the user just talk to an open page.
  {
    type: "function" as const,
    function: {
      name: "browser_open",
      description:
        "Open / navigate the user's controlled browser to one website and return the initial snapshot refs in the same result. Use when the user wants to do something ON a site that needs their login (dashboards, account pages). `url` is a full https URL or a known site name. After browser_open, use the returned `[ref]` lines directly for browser_act; do not call browser_snapshot just to get the first refs. After one browser_open attempt in a turn, do not call browser_open again unless the user explicitly asked for a different website; use browser_act, browser_read, or browser_snapshot on the current page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "full https URL or a known site name (e.g. 'github', 'https://platform.openai.com/usage')" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_snapshot",
      description:
        "Look at the page currently open in the controlled browser so you can find clickable/typeable targets. It returns a compact ref map like `[ref] role \"name\"`, plus href/viewport/clickable-parent/frame hints and any detected login requirement. It is NOT the page reader and may omit long prose, search-result snippets, course descriptions, table text, and article content. Use browser_read when the user asks what the page says, what you found, or when you need readable page text. Do not call browser_snapshot immediately after browser_open because browser_open already returns the initial snapshot. Snapshot after clicks/filter changes when you need updated refs, or when an action reports its target is missing. If snapshot returns count 0 or says no clickable elements were found, use browser_read to inspect readable text, or browser_scroll to reveal more refs and return a fresh snapshot. If it reports the browser is closed, tell the user to open a site first; if it reports a login is needed, warn them — you CANNOT do Google/SSO/'continue with…' logins or submit passwords yourself.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_scroll",
      description:
        "Scroll the controlled browser's current page and return a fresh snapshot. The default scroll moves about 75% of the viewport so the new snapshot overlaps the previous one and should not skip content near the edge. Use this when the latest browser_open/browser_snapshot/browser_act result does not show the target you need, or when you need more visible refs before clicking/typing/selecting/checking. This tool does not click, type, select, check, or read page prose. After browser_scroll, use the returned snapshot refs for browser_act, call browser_scroll one more time if the target is still not visible, or use browser_read if the user asked what the page says/results are. Do not call browser_scroll more than twice in one user request.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["down", "up"],
            description: "which way to scroll; default is down",
          },
          amount: {
            type: ["number", "null"],
            description: "optional pixels to scroll; omit this for the safe default overlapped viewport step",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_act",
      description:
        "Perform ONE action on the controlled browser's current page. For click/type/select/check, `ref` is required and must be the numeric `[ref]` from the latest browser_open, browser_snapshot, browser_scroll, or browser_act snapshot result; do not pass labels, CSS selectors, or words like 'courses' as ref. For back/enter, omit ref. Every successful action returns a fresh snapshot; use that returned snapshot to decide the next click. Do not use browser_read just to verify a click/filter if the snapshot already shows enough state. Use browser_read after navigating/filtering when the user asked what the page says, what courses/results you found, or when you need final readable prose/table/search-result text. If a click/type/select/check target is missing, call browser_scroll to reveal more refs, then retry with a ref from the fresh snapshot. Never try to log in via Google/SSO or submit a password — tell the user to do that themselves.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["click", "type", "select", "check", "back", "enter"],
            description: "what to do. click/type/select/check need a ref; back/enter don't. Use browser_scroll for scrolling.",
          },
          ref: { type: ["number", "null"], description: "the [ref] number of the target element (for click/type/select/check)" },
          text: { type: ["string", "null"], description: "text to type/select (for action 'type' or 'select')" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "browser_read",
      description:
        "Read the human-readable text from the page currently open in the controlled browser. It takes NO ref and does not click anything. Use it to answer or summarize what is on the current page after opening, searching, clicking, filtering, or scrolling: articles, search-result snippets, course/result lists, table text, instructions, and page prose. browser_snapshot is only a ref map for interaction targets and can omit this readable content. Do not use browser_read just to verify a click/filter when browser_act's returned snapshot already shows enough state; use it when you need the actual words/results to tell the user what you found. Returns page text, or a closed-browser/login notice.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "play_spotify",
      description:
        "PLAY on Spotify (Premium) on the active device. 'play Bohemian Rhapsody' (track), 'play the album X', 'play my Discover Weekly' (playlist), 'play some Sam Smith' (artist). Pick the right type.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "song, album, playlist, or artist name" },
          type: {
            type: "string",
            enum: ["track", "album", "playlist", "artist"],
            description:
              "what to play. 'track' (default) for a song; 'artist' for 'play some <artist>'; 'album'/'playlist' when the user says album/playlist.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "queue_spotify",
      description:
        "Add a song to the Spotify queue to play after the current one (e.g. 'queue up X', 'add X to the queue', 'play X next').",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "song to queue" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "spotify_control",
      description:
        "Control ongoing Spotify playback. Use for: pause, resume, next/skip, previous, set volume ('turn it up/down', 'volume 30'), shuffle on/off, repeat off/one/all, save/like the CURRENT song ('save this'), restart the song, jump to a time ('skip to 1 minute'), switch device ('play on my phone'), or 'what's playing'.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "pause", "resume", "next", "previous", "now_playing",
              "volume", "shuffle_on", "shuffle_off",
              "repeat_off", "repeat_one", "repeat_all",
              "save", "restart", "seek", "transfer",
            ],
          },
          volume: { type: ["number", "null"], description: "0-100, for action 'volume'" },
          seconds: { type: ["number", "null"], description: "position in seconds, for action 'seek'" },
          device: { type: ["string", "null"], description: "device name, for action 'transfer' (e.g. 'phone', 'computer')" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "open_app",
      description:
        "Open something on the user's computer. DEFAULT for bare 'open X' ('open Spotify/Discord/notepad/Gmail/YouTube'), 'open the X app', AND opening a FOLDER by name ('open internship orders', 'open the chip folder'). The bridge tries: installed app → known website → a matching folder under the user's folders. Works WITHOUT developer mode. Confirms before opening.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "the app/site/folder name, e.g. 'spotify', 'discord', 'internship orders'. For 'open the chip folder' pass just 'chip' (drop the word 'folder').",
          },
          only: {
            type: ["string", "null"],
            enum: ["app", "folder", null],
            description:
              "set 'app' if the user explicitly said 'X app' (open the app only), 'folder' if they said 'X folder' (open the folder only). Omit for a plain 'open X' (tries app → folder → website).",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "run_shell",
      description:
        "DEVELOPER MODE: run an arbitrary PowerShell command on the user's Windows machine. Use ONLY when the user explicitly asks to run a command / PowerShell / script (e.g. 'run the command ...', 'in PowerShell ...'). To simply OPEN A FOLDER by name, do NOT use this — use open_app (it opens folders without developer mode). " +
        "PATHS: you do NOT know the user's Windows username — NEVER hardcode 'C:\\\\Users\\\\<name>' or a placeholder like '[username]'. Build paths from PowerShell environment variables in DOUBLE quotes so they resolve on the machine: e.g. `explorer \"$env:USERPROFILE\\Downloads\"`. Use double quotes (single quotes won't expand $env:). " +
        "Write ONE plain, readable command — never encoded, remote-fetch (iex/irm), or destructive (delete/format/registry/shutdown); those are rejected. The user reviews the exact command and taps Run before anything executes.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "the literal PowerShell command to run, e.g. 'Get-Date' or 'Get-Process | Sort CPU -Desc | Select -First 5'",
          },
          label: {
            type: "string",
            description: "a short plain-English description of what the command does, for the confirmation prompt",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description:
        "Send a message to a person for free (NOT a calendar reminder/note). Use for 'text/message/WhatsApp/Telegram/email <someone> <something>', 'tell Mom I'll be late', 'let Alex know the meeting moved'. `to` is a saved contact name OR a raw handle (phone, @username, or email). Telegram and email send immediately; WhatsApp opens on the user's computer and is confirmed first.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "string",
            description:
              "contact name (e.g. 'Mom') or a raw handle: a phone number for WhatsApp, an @username/chat id for Telegram, or an email address",
          },
          channel: {
            type: ["string", "null"],
            enum: ["whatsapp", "telegram", "email", null],
            description:
              "how to send it. Infer from the user: 'text/whatsapp X' => whatsapp; 'telegram/dm X' => telegram; 'email X' => email. Omit to auto-pick from what the contact has.",
          },
          message: {
            type: "string",
            description: "the message body to send, phrased as the user wants it",
          },
          subject: {
            type: ["string", "null"],
            description: "email subject line (email channel only); omit otherwise",
          },
        },
        required: ["to", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "add_contact",
      description:
        "Save or update a person in the contacts book so they can be messaged by name later (e.g. 'add Mom, WhatsApp +6591234567', 'save Alex's email alex@x.com'). Only the handles given are changed; others are kept.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "the contact's name" },
          phone: { type: ["string", "null"], description: "phone number for WhatsApp, e.g. +6591234567" },
          telegram: { type: ["string", "null"], description: "Telegram numeric chat id or @username" },
          email: { type: ["string", "null"], description: "email address" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_contacts",
      description:
        "List saved contacts and which channels they have. Use for 'who are my contacts', 'do I have Mom saved', 'delete the contact Alex' (set remove=true).",
      parameters: {
        type: "object",
        properties: {
          remove: {
            type: ["string", "null"],
            description: "name of a contact to DELETE; omit to just list",
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "sync_contacts",
      description:
        "Import the user's contacts so people can be messaged by name. Use for 'import/sync my contacts', 'load my Google contacts', 'get my Telegram contacts'. Pulls from Google Contacts (names, phones, emails) and, if set up, Telegram.",
      parameters: {
        type: "object",
        properties: {
          source: {
            type: ["string", "null"],
            enum: ["google", "telegram", "all", null],
            description:
              "which source to import from; 'all' (default) does Google + Telegram.",
          },
        },
      },
    },
  },
];

// ── Coding-mode file tools (LOCAL ONLY) ─────────────────────────────────────
// Real file read/write/edit/list tools for the autonomous coding agent. They are
// SCOPED to a project's working folder and executed only via /api/coding/tool
// (lib/coding.ts → runCodingFileTool), never through the voice/cloud execTool —
// so they are intentionally kept OUT of `toolDefs`.
export const CODING_FILE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "list_dir",
      description:
        "List the files and folders inside the project working folder. `path` is relative to the project root (omit or '.' for the root). Use this to explore the codebase before editing.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "folder path relative to the project root (default '.')" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description:
        "Read the full text of a file in the project working folder. `path` is relative to the project root. Always read a file before editing it.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "file path relative to the project root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file",
      description:
        "Create or OVERWRITE a file in the project working folder with the given content. `path` is relative to the project root; parent folders are created as needed. Use edit_file for small changes to an existing file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "file path relative to the project root" },
          content: { type: "string", description: "the full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file",
      description:
        "Replace an exact, UNIQUE snippet of text in an existing file with new text (like a precise find-and-replace). `old` must match the file exactly and appear once. Prefer this over write_file for targeted changes.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "file path relative to the project root" },
          old: { type: "string", description: "the exact existing text to replace (must be unique in the file)" },
          new: { type: "string", description: "the replacement text" },
        },
        required: ["path", "old", "new"],
      },
    },
  },
];

// Names of the coding file tools, for the client loop's dispatcher.
export const CODING_FILE_TOOL_NAMES = new Set(CODING_FILE_TOOLS.map((t) => t.function.name));

// The agentic browser tool defs (subset of toolDefs), reused by the coding prompt.
export const BROWSER_TOOL_DEFS = toolDefs.filter((d) =>
  ["browser_open", "browser_snapshot", "browser_scroll", "browser_act", "browser_read"].includes(d.function.name)
);
// The run_shell tool def, reused by the coding prompt.
export const RUN_SHELL_TOOL_DEF = toolDefs.find((d) => d.function.name === "run_shell");

// The CLOUD toolset: every tool the cloud agent can actually execute itself. The
// agentic browser tools are excluded — they drive the user's local Chromium via
// the bridge, which only the client can reach, so a cloud model must never be
// handed them. This is the full schema the fully model-driven cloud voice path
// ships (no keyword pre-filtering).
export const CLOUD_TOOLS = toolDefs.filter(
  (d) => !BROWSER_TOOL_DEFS.some((b) => b.function.name === d.function.name)
);

// ── Tool routing ──────────────────────────────────────────────────────────
// To keep each LLM call small (Groq's per-minute token limit is tight), we send
// only the tools likely relevant to the request. The CORE productivity tools
// (tasks/events/notes) are ALWAYS included, so ordinary requests can never lose
// a tool they need; only the domain groups (email/spotify/apps) are gated behind
// strong, unambiguous keywords. Falls open (includes a group) on any match.
const CORE_TOOLS = new Set([
  "create_task", "update_task", "delete_task", "complete_all", "list_tasks",
  "create_event", "update_event", "delete_event", "list_events",
  "create_note", "search_notes", "update_note", "delete_note",
  "create_project", "list_projects", "update_project", "delete_project", "project_time",
  "delete_all",
]);

// Each group has a stable `key` so the agent can also include the matching
// RULE block (not just the tools) only when relevant — keeping every request's
// prompt small. The core task/event/note rules are always present (and form a
// stable, cacheable prefix); only these domain blocks vary.
export type GroupKey = "email" | "spotify" | "local" | "shell" | "search" | "message";

// Every domain group. Used by the LOCAL "all tools" path: a local model has no
// token budget to protect, so it gets the entire toolset + all rule blocks.
export const ALL_GROUPS: GroupKey[] = ["email", "spotify", "local", "shell", "search", "message"];

const TOOL_GROUPS: { key: GroupKey; tools: string[]; re: RegExp }[] = [
  {
    key: "email",
    tools: ["list_emails", "mark_emails_reviewed", "fetch_emails_now"],
    re: /\b(email|emails|e-mail|mail|inbox|gmail|digest|unread|reviewed|newsletter|sender)\b/i,
  },
  {
    key: "spotify",
    tools: ["play_spotify", "queue_spotify", "spotify_control"],
    re: /\b(play|playing|song|songs|music|spotify|pause|resume|skip|next|previous|track|tracks|volume|louder|quieter|mute|shuffle|repeat|queue|artist|album|playlist)\b|turn (it )?(up|down)/i,
  },
  {
    key: "local",
    tools: ["open_app", "read_site"],
    // "folder"/"directory" live here (not shell): opening a folder by name goes
    // through open_app's folder fallback, which works WITHOUT developer mode.
    re: /\b(open|launch|website|site|browser|google|search|go to|app|tab|folder|directory|youtube|discord|whatsapp|spotify|notepad|calculator|explorer)\b|\.\w{2,}/i,
  },
  {
    key: "shell",
    // Developer mode: only surface the shell tool on explicit, unambiguous
    // COMMAND intent so it's never picked for an ordinary "open" request.
    tools: ["run_shell"],
    re: /\b(powershell|command line|terminal|shell|run (the |a )?command|run this|execute|cmdlet|script)\b/i,
  },
  {
    key: "search",
    // Informational / general-knowledge questions → read a page back. Broad on
    // purpose; mis-routes still self-heal in lib/agent.ts. (Web SEARCH tools were
    // removed — the controlled browser handles searching now.)
    tools: ["read_site"],
    re: /\b(who|what|what's|whats|where|when|why|how|which|best|top|cheapest|nearest|near|nearby|recommend|recommendation|find me|look up|lookup|weather|news|price|cost|review|reviews|restaurant|food|places|directions|distance|score|results?|latest|current)\b|\?\s*$/i,
  },
  {
    key: "message",
    // Sending a message TO a person (free) + managing the contacts book.
    // "text"/"tell"/"send" are intentionally here; mis-routes self-heal.
    tools: ["send_message", "add_contact", "list_contacts", "sync_contacts"],
    re: /\b(message|messages|whatsapp|telegram|dm|imessage|texting|contact|contacts|notify|sync|import)\b|\b(text|tell|send|msg|message|email|let)\b.{0,30}\b(mom|dad|him|her|them|to|that|know|saying)\b/i,
  },
];

// Which domain groups this message activates. Used to gate BOTH the tools and
// their matching rule blocks so the prompt stays minimal.
export function activeGroups(userText: string): Set<GroupKey> {
  const t = userText || "";
  const out = new Set<GroupKey>();
  for (const g of TOOL_GROUPS) if (g.re.test(t)) out.add(g.key);
  return out;
}

// Return the subset of toolDefs to send for this user message.
export function selectTools(userText: string, groups = activeGroups(userText)) {
  const names = new Set(CORE_TOOLS);
  for (const g of TOOL_GROUPS) {
    if (groups.has(g.key)) for (const n of g.tools) names.add(n);
  }
  return toolDefs.filter((d) => names.has(d.function.name));
}

// Return exactly the named tools, in registry order. Used by the keyword router
// to send only an ability's own tools (a much smaller request than selectTools).
export function toolsByNames(names: string[]) {
  const want = new Set(names);
  return toolDefs.filter((d) => want.has(d.function.name));
}

type Args = Record<string, any>;

// Executes a tool call and returns a JSON-serializable result fed back to the LLM.
export async function runTool(name: string, rawArgs: Args): Promise<unknown> {
  const args = rawArgs ?? {};
  // The agentic browser tools drive the user's real browser via the localhost
  // bridge — only the CLIENT can reach that (lib/local-agent.ts dispatches them).
  // The cloud server can't, so never execute them here; this guard exists only
  // in case a cloud model is ever handed one by mistake.
  if (name === "browser_open" || name === "browser_snapshot" || name === "browser_scroll" || name === "browser_act" || name === "browser_read") {
    return { error: "The controlled browser only runs on your own machine — switch to local mode (with the bridge running) to drive it." };
  }
  try {
    return await execTool(name, args);
  } catch (err: any) {
    // Return the error to the model so it can recover (e.g. look up a real id)
    // instead of throwing a 500 that kills the whole request.
    return { error: err?.message || "tool execution failed" };
  }
}

// If args carry a ref (e.g. "Task 3"), return its parsed seq when it matches
// the expected kind. The seq is a deterministic lookup — no fuzzy guessing.
function refSeq(args: Args, kind: "task" | "event" | "note" | "project"): number | null {
  const parsed = parseRef(args.ref ?? "");
  return parsed && parsed.kind === kind ? parsed.seq : null;
}

// Resolve a task by ref (exact), else explicit id, else fuzzy title (open, newest).
async function resolveTaskId(args: Args): Promise<string | null> {
  const seq = refSeq(args, "task");
  if (seq !== null) {
    const rows = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(eq(tasks.seq, seq))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  if (args.id) return args.id;
  const t = (args.title ?? "").trim();
  if (!t) return null;
  const rows = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(ilike(tasks.title, `%${t}%`))
    .orderBy(asc(tasks.done), desc(tasks.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveEventId(args: Args): Promise<string | null> {
  const seq = refSeq(args, "event");
  if (seq !== null) {
    const rows = await db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.seq, seq))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  if (args.id) return args.id;
  const t = (args.title ?? "").trim();
  if (!t) return null;
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(ilike(events.title, `%${t}%`))
    .orderBy(desc(events.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveNoteId(args: Args): Promise<string | null> {
  const seq = refSeq(args, "note");
  if (seq !== null) {
    const rows = await db
      .select({ id: notes.id })
      .from(notes)
      .where(eq(notes.seq, seq))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  if (args.id) return args.id;
  const q = (args.query ?? args.title ?? "").trim();
  if (!q) return null;
  const rows = await db
    .select({ id: notes.id })
    .from(notes)
    .where(or(ilike(notes.body, `%${q}%`), ilike(notes.title, `%${q}%`)))
    .orderBy(desc(notes.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function resolveProjectId(args: Args): Promise<string | null> {
  const seq = refSeq(args, "project");
  if (seq !== null) {
    const rows = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.seq, seq))
      .limit(1);
    return rows[0]?.id ?? null;
  }
  if (args.id) return args.id;
  const t = (args.title ?? "").trim();
  if (!t) return null;
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(ilike(projects.title, `%${t}%`))
    .orderBy(desc(projects.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function execTool(name: string, args: Args): Promise<unknown> {
  switch (name) {
    case "create_task": {
      const [row] = await db
        .insert(tasks)
        .values({
          title: args.title,
          notes: args.notes ?? null,
          priority: args.priority ?? "medium",
          dueDate: args.due_date ? new Date(args.due_date) : null,
        })
        .returning();
      return row;
    }
    case "update_task": {
      const id = await resolveTaskId(args);
      if (!id) return { error: "no matching task found" };
      const patch: Args = {};
      // title is the matcher when matched by title, so only rename when the row
      // was pinned by ref/id.
      if ((args.id || args.ref) && args.title !== undefined) patch.title = args.title;
      if (args.notes !== undefined) patch.notes = args.notes;
      if (args.done !== undefined) patch.done = args.done;
      if (args.priority !== undefined) patch.priority = args.priority;
      if (args.due_date !== undefined)
        patch.dueDate = args.due_date ? new Date(args.due_date) : null;
      const [row] = await db
        .update(tasks)
        .set(patch)
        .where(eq(tasks.id, id))
        .returning();
      return row ?? { error: "task not found" };
    }
    case "delete_task": {
      const id = await resolveTaskId(args);
      if (!id) return { error: "no matching task found" };
      const [row] = await db
        .delete(tasks)
        .where(eq(tasks.id, id))
        .returning();
      return row ? { deleted: true } : { error: "task not found" };
    }
    case "complete_all": {
      const target = args.target ?? "all";
      const out: Args = {};
      if (target === "tasks" || target === "all") {
        const rows = await db
          .update(tasks)
          .set({ done: true })
          .where(eq(tasks.done, false))
          .returning();
        out.completed_tasks = rows.length;
      }
      if (target === "events" || target === "all") {
        const rows = await db
          .update(events)
          .set({ done: true })
          .where(eq(events.done, false))
          .returning();
        out.completed_events = rows.length;
      }
      if (target === "projects" || target === "all") {
        const rows = await db
          .update(projects)
          .set({ done: true, updatedAt: new Date() })
          .where(eq(projects.done, false))
          .returning();
        out.completed_projects = rows.length;
      }
      return out;
    }
    case "list_tasks": {
      const rows = await db
        .select()
        .from(tasks)
        .where(args.only_open ? eq(tasks.done, false) : undefined)
        .orderBy(asc(tasks.dueDate));
      return rows;
    }
    case "delete_all": {
      const target = args.target ?? "all";
      const status = args.status ?? "all"; // all | completed | open
      const taskWhere =
        status === "completed" ? eq(tasks.done, true)
        : status === "open" ? eq(tasks.done, false)
        : undefined; // undefined => every row, marked or not
      const eventWhere =
        status === "completed" ? eq(events.done, true)
        : status === "open" ? eq(events.done, false)
        : undefined;
      const projectWhere =
        status === "completed" ? eq(projects.done, true)
        : status === "open" ? eq(projects.done, false)
        : undefined;
      const out: Args = {};
      if (target === "tasks" || target === "all") {
        const rows = await db.delete(tasks).where(taskWhere).returning();
        out.deleted_tasks = rows.length;
      }
      if (target === "events" || target === "all") {
        const rows = await db.delete(events).where(eventWhere).returning();
        out.deleted_events = rows.length;
      }
      if (target === "projects" || target === "all") {
        const rows = await db.delete(projects).where(projectWhere).returning();
        out.deleted_projects = rows.length;
      }
      // Notes have no completed/open state, so only wipe them when no status
      // filter was asked for (otherwise "delete completed" shouldn't touch notes).
      if ((target === "notes" || target === "all") && status === "all") {
        const rows = await db.delete(notes).returning();
        out.deleted_notes = rows.length;
      }
      return out;
    }
    case "create_event": {
      const [row] = await db
        .insert(events)
        .values({
          title: args.title,
          location: args.location ?? null,
          startTime: new Date(args.start_time),
          endTime: new Date(args.end_time),
          recurrence: args.recurrence ?? "none",
          recurrenceEnd: args.recurrence_end
            ? new Date(args.recurrence_end)
            : null,
        })
        .returning();
      return row;
    }
    case "update_event": {
      const id = await resolveEventId(args);
      if (!id) return { error: "no matching event found" };
      const patch: Args = {};
      if ((args.id || args.ref) && args.title !== undefined) patch.title = args.title;
      if (args.location !== undefined) patch.location = args.location;
      if (args.done !== undefined) patch.done = args.done;
      if (args.start_time !== undefined)
        patch.startTime = new Date(args.start_time);
      if (args.end_time !== undefined) patch.endTime = new Date(args.end_time);
      if (args.recurrence !== undefined) patch.recurrence = args.recurrence;
      if (args.recurrence_end !== undefined)
        patch.recurrenceEnd = args.recurrence_end
          ? new Date(args.recurrence_end)
          : null;
      const [row] = await db
        .update(events)
        .set(patch)
        .where(eq(events.id, id))
        .returning();
      return row ?? { error: "event not found" };
    }
    case "delete_event": {
      const id = await resolveEventId(args);
      if (!id) return { error: "no matching event found" };
      const [row] = await db
        .delete(events)
        .where(eq(events.id, id))
        .returning();
      return row ? { deleted: true } : { error: "event not found" };
    }
    case "list_events": {
      const from = new Date(args.from);
      const to = new Date(args.to);
      // Fetch any event that starts on/before the window end (recurring ones
      // may have started earlier), then expand occurrences into [from, to].
      const rows = await db
        .select()
        .from(events)
        .where(lte(events.startTime, to))
        .orderBy(asc(events.startTime));
      const occ = expandEvents(
        rows.map((r) => ({
          id: r.id,
          title: r.title,
          location: r.location,
          startTime: r.startTime.toISOString(),
          endTime: r.endTime.toISOString(),
          recurrence: r.recurrence,
          recurrenceEnd: r.recurrenceEnd
            ? r.recurrenceEnd.toISOString()
            : null,
          projectId: r.projectId,
        })),
        from,
        to
      );
      // Tag each occurrence so the agent can tell a plain event from a
      // "project event" (time scheduled for a project) when reading back.
      return occ.map((o) => ({
        ...o,
        kind: o.projectId ? "project_event" : "event",
      }));
    }
    case "create_note": {
      const [row] = await db
        .insert(notes)
        .values({ title: args.title ?? null, body: args.body })
        .returning();
      return row;
    }
    case "search_notes": {
      const q = (args.query ?? "").trim();
      const rows = await db
        .select()
        .from(notes)
        .where(
          q
            ? or(ilike(notes.body, `%${q}%`), ilike(notes.title, `%${q}%`))
            : undefined
        )
        .orderBy(desc(notes.createdAt))
        .limit(20);
      return rows;
    }
    case "update_note": {
      const id = await resolveNoteId(args);
      if (!id) return { error: "no matching note found" };
      const patch: Args = { updatedAt: new Date() };
      if (args.title !== undefined) patch.title = args.title;
      if (args.body !== undefined) patch.body = args.body;
      const [row] = await db
        .update(notes)
        .set(patch)
        .where(eq(notes.id, id))
        .returning();
      return row ?? { error: "note not found" };
    }
    case "delete_note": {
      const id = await resolveNoteId(args);
      if (!id) return { error: "no matching note found" };
      const [row] = await db.delete(notes).where(eq(notes.id, id)).returning();
      return row ? { deleted: true } : { error: "note not found" };
    }
    case "create_project": {
      const title = (args.title ?? "").trim();
      if (!title) return { error: "no project title given" };
      const first = (args.improvement ?? "").trim();
      const [row] = await db
        .insert(projects)
        .values({ title, improvements: first ? [first] : [] })
        .returning();
      return row;
    }
    case "list_projects": {
      // One project (ref/title) or all of them.
      if (args.ref || args.title) {
        const id = await resolveProjectId(args);
        if (!id) return { error: "no matching project found" };
        const [row] = await db
          .select()
          .from(projects)
          .where(eq(projects.id, id))
          .limit(1);
        if (!row) return { error: "project not found" };
        return {
          project: {
            ref: refOf("project", row.seq),
            title: row.title,
            improvements: row.improvements ?? [],
          },
        };
      }
      const rows = await db.select().from(projects).orderBy(asc(projects.seq));
      return {
        count: rows.length,
        projects: rows.map((p) => ({
          ref: refOf("project", p.seq),
          title: p.title,
          improvements: p.improvements ?? [],
        })),
      };
    }
    case "update_project": {
      const id = await resolveProjectId(args);
      if (!id) return { error: "no matching project found" };
      const [row] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (!row) return { error: "project not found" };
      const patch: Args = { updatedAt: new Date() };
      if (args.new_title !== undefined && args.new_title !== null)
        patch.title = args.new_title;
      if (args.done !== undefined && args.done !== null) patch.done = args.done;
      let improvements = [...(row.improvements ?? [])];
      if (typeof args.edit_improvement_number === "number") {
        const idx = args.edit_improvement_number - 1;
        if (idx < 0 || idx >= improvements.length)
          return { error: `project has no improvement #${args.edit_improvement_number}` };
        if (args.edit_improvement_text)
          improvements[idx] = String(args.edit_improvement_text);
      }
      if (typeof args.remove_improvement_number === "number") {
        const idx = args.remove_improvement_number - 1;
        if (idx < 0 || idx >= improvements.length)
          return { error: `project has no improvement #${args.remove_improvement_number}` };
        improvements.splice(idx, 1);
      }
      if (args.add_improvement) improvements.push(String(args.add_improvement));
      patch.improvements = improvements;
      const [updated] = await db
        .update(projects)
        .set(patch)
        .where(eq(projects.id, id))
        .returning();
      return {
        ref: refOf("project", updated.seq),
        title: updated.title,
        improvements: updated.improvements ?? [],
      };
    }
    case "delete_project": {
      const id = await resolveProjectId(args);
      if (!id) return { error: "no matching project found" };
      const [row] = await db
        .delete(projects)
        .where(eq(projects.id, id))
        .returning();
      return row ? { deleted: true } : { error: "project not found" };
    }
    case "project_time": {
      const id = await resolveProjectId(args);
      if (!id) return { error: "no matching project found" };
      const [proj] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, id))
        .limit(1);
      if (!proj) return { error: "project not found" };
      const action = args.action ?? "add";

      const HOUR_MS = 60 * 60 * 1000;
      if (action === "add") {
        if (!args.start_time)
          return { error: "start_time is required to add a time" };
        const start = new Date(args.start_time);
        // end_time is optional — default to one hour after the start.
        const end = args.end_time
          ? new Date(args.end_time)
          : new Date(start.getTime() + HOUR_MS);
        const [row] = await db
          .insert(events)
          .values({
            title: proj.title,
            startTime: start,
            endTime: end,
            projectId: id,
          })
          .returning();
        return {
          scheduled: true,
          ref: refOf("event", row.seq),
          project: refOf("project", proj.seq),
          title: row.title,
          start: row.startTime.toISOString(),
        };
      }

      // reschedule / cancel — locate the project's target time (event).
      const evs = await db
        .select()
        .from(events)
        .where(eq(events.projectId, id))
        .orderBy(asc(events.startTime));
      if (evs.length === 0)
        return { error: `${refOf("project", proj.seq)} has no scheduled time` };
      let target = evs[0];
      const evParsed = parseRef(args.event_ref ?? "");
      if (evParsed && evParsed.kind === "event") {
        const found = evs.find((e) => e.seq === evParsed.seq);
        if (!found)
          return { error: `${refOf("event", evParsed.seq)} isn't a time on ${refOf("project", proj.seq)}` };
        target = found;
      } else if (evs.length > 1) {
        // Ambiguous — ask which one, listing the options with their refs.
        return {
          error: "that project has multiple scheduled times — say which one",
          times: evs.map((e) => ({
            ref: refOf("event", e.seq),
            start: e.startTime.toISOString(),
          })),
        };
      }

      if (action === "cancel") {
        await db.delete(events).where(eq(events.id, target.id));
        return { cancelled: true, ref: refOf("event", target.seq), project: refOf("project", proj.seq) };
      }
      // reschedule
      if (!args.start_time)
        return { error: "start_time is required to reschedule" };
      const start = new Date(args.start_time);
      // end_time is optional — keep the time's original length (fallback 1h).
      const origMs = target.endTime.getTime() - target.startTime.getTime();
      const end = args.end_time
        ? new Date(args.end_time)
        : new Date(start.getTime() + (origMs > 0 ? origMs : HOUR_MS));
      const [row] = await db
        .update(events)
        .set({ startTime: start, endTime: end })
        .where(eq(events.id, target.id))
        .returning();
      return {
        rescheduled: true,
        ref: refOf("event", row.seq),
        project: refOf("project", proj.seq),
        start: row.startTime.toISOString(),
      };
    }
    case "list_emails": {
      const matches = await matchEmails({
        query: args.query,
        minUrgency: args.min_urgency,
        unreviewedOnly: args.unreviewed_only,
        // For digest/recent requests, scope to today's local date so the voice
        // reply matches what the Digest/Inbox tabs show.
        date: args.today_only ? localDateKey(new Date()) : undefined,
      });
      // matchEmails returns urgency-sorted; re-sort by recency when asked.
      if (args.order === "recent") {
        matches.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      }
      const limit = args.limit && args.limit > 0 ? args.limit : 10;
      const out = matches.slice(0, limit).map((s) => ({
        from: s.from,
        subject: s.subject,
        summary: s.summary,
        urgency: s.urgency,
        category: s.category,
        reviewed: s.reviewed,
        deadline: s.deadlineMentioned,
        receivedAt: s.receivedAt,
      }));
      return { count: out.length, total_matched: matches.length, emails: out };
    }
    case "mark_emails_reviewed": {
      const reviewed = args.reviewed ?? true;
      const targets = args.all
        ? await listSummaries({})
        : await matchEmails({ query: args.query });
      if (!args.all && !(args.query ?? "").trim()) {
        return { error: "specify a sender/keyword, or set all=true" };
      }
      let updated = 0;
      for (const s of targets) {
        if (s.reviewed === reviewed) continue;
        const date = s.receivedAt.slice(0, 10);
        await setSummary(date, s.emailId, { ...s, reviewed });
        updated++;
      }
      return { updated, reviewed };
    }
    case "fetch_emails_now": {
      const r = await runFetch();
      if (!r.ok) return { error: r.error ?? "fetch failed" };
      if (r.newCount === 0) return { new_emails: 0, message: "No new emails." };
      return {
        new_emails: r.newCount,
        emails: r.newSummaries
          .sort((a, b) => b.urgency - a.urgency)
          .map((s) => ({
            from: s.from,
            subject: s.subject,
            summary: s.summary,
            urgency: s.urgency,
            category: s.category,
            deadline: s.deadlineMentioned,
          })),
      };
    }
    // Local actions: we can't reach the user's machine from the server, so we
    // return an intent the browser confirms with the user and forwards to the
    // local bridge. Shape: { local_action, target, label, pending }.
    // Read/summarize a page's CONTENT (no browser opened). Runs entirely on the
    // server: resolve the site to a URL, fetch (cache-first) and return clean
    // text. The agent (lib/agent.ts) phrases the summary/read-out from this,
    // bypassing the short spoken-reply cap since it's longform. Only works for
    // PUBLIC pages — logged-in/JS-only pages go through the bridge (Phase 2).
    case "read_site": {
      const site = (args.site ?? "").trim();
      if (!site) return { error: "no site given" };
      const mode = args.mode === "read" ? "read" : "summarize";
      try {
        const page = await readPage(resolveUrl(site));
        return {
          read_site: true,
          longform: true,
          mode,
          url: page.url,
          title: page.title,
          truncated: page.truncated,
          fromCache: page.fromCache,
          content: page.text,
        };
      } catch (e: any) {
        return { error: e?.message || "I couldn't read that page." };
      }
    }
    // Controlled-browser command (Phase 2): the routing layer already parsed the
    // intent (open in browser / read this page / single click·type·scroll). The
    // SERVER can't touch a logged-in page, so we just echo it back as a browser
    // intent — the client (VoiceButton) drives the bridge and confirms acts.
    case "browser_cmd": {
      const kind = args.kind;
      if (kind !== "open" && kind !== "read" && kind !== "act" && kind !== "macro") {
        return { error: "unknown browser command" };
      }
      const url = args.url ? String(args.url) : undefined;
      // Startup steps are no longer auto-attached here — they live in the user's
      // memory (lib/memory.ts) and the model performs them itself after opening.
      return {
        local_action: "browser",
        browser_kind: kind,
        ...(url ? { url } : {}),
        ...(args.mode ? { mode: String(args.mode) } : {}),
        ...(args.instruction ? { instruction: String(args.instruction) } : {}),
        ...(Array.isArray(args.actions) ? { actions: args.actions.map((a: unknown) => String(a)) } : {}),
        label: String(args.label ?? ""),
        pending: true,
        // Neutral message so the deterministic reply path needs no LLM; the client
        // ignores it and speaks its own progress as it drives the browser.
        message: "On it.",
        note: "Proposed only — runs in the user's controlled browser via the bridge.",
      };
    }
    // open_url is no longer a model-facing tool (browser_open covers opening sites)
    // and the deterministic shortcut routing that used to call it is gone. Kept as a
    // harmless no-op handler; the model opens saved shortcuts via browser_open using
    // the URLs it reads from memory.
    case "open_url": {
      const site = (args.site ?? "").trim();
      if (!site) return { error: "no site given" };
      return {
        local_action: "open",
        target: resolveUrl(site),
        label: site,
        pending: true,
        note: "Proposed only — the user's device will confirm before opening.",
      };
    }
    case "play_spotify": {
      const query = (args.query ?? "").trim();
      if (!query) return { error: "no song given" };
      const type = args.type ?? "track";
      const r =
        type === "track"
          ? await spotify.playQuery(query)
          : await spotify.playContext(query, type);
      return r.ok ? { played: true, message: r.message } : { error: r.message };
    }
    case "queue_spotify": {
      const query = (args.query ?? "").trim();
      if (!query) return { error: "no song given" };
      const r = await spotify.queueTrack(query);
      return r.ok ? { ok: true, message: r.message } : { error: r.message };
    }
    case "spotify_control": {
      const action = args.action;
      let r: spotify.SpotifyResult;
      switch (action) {
        case "pause": r = await spotify.pause(); break;
        case "resume": r = await spotify.resume(); break;
        case "next": r = await spotify.next(); break;
        case "previous": r = await spotify.previous(); break;
        case "now_playing": r = await spotify.nowPlaying(); break;
        case "shuffle_on": r = await spotify.setShuffle(true); break;
        case "shuffle_off": r = await spotify.setShuffle(false); break;
        case "repeat_off": r = await spotify.setRepeat("off"); break;
        case "repeat_one": r = await spotify.setRepeat("one"); break;
        case "repeat_all": r = await spotify.setRepeat("all"); break;
        case "save": r = await spotify.saveCurrent(); break;
        case "restart": r = await spotify.seek(0); break;
        case "volume": {
          if (typeof args.volume !== "number")
            return { error: "volume (0-100) is required" };
          r = await spotify.setVolume(args.volume);
          break;
        }
        case "seek": {
          if (typeof args.seconds !== "number")
            return { error: "seconds is required for seek" };
          r = await spotify.seek(args.seconds);
          break;
        }
        case "transfer": {
          if (!args.device) return { error: "device name is required for transfer" };
          r = await spotify.transfer(args.device);
          break;
        }
        default:
          return { error: `unknown spotify action ${action}` };
      }
      return r.ok ? { ok: true, message: r.message } : { error: r.message };
    }
    case "open_app": {
      const name = (args.name ?? "").trim();
      if (!name) return { error: "no app name given" };
      const only = args.only === "app" || args.only === "folder" ? args.only : undefined;
      // DEFAULT (no `only`): send a website fallback so the bridge finishes the
      // chain in code (app → folder → website), no AI — "open apple" → apple.com,
      // "open notepad" still launches the app first. EXPLICIT "X app"/"X folder":
      // force that kind and send NO website fallback, so it opens the right thing
      // (or reports it isn't found) instead of a random site.
      const fallback = only ? undefined : knownSiteUrl(name) ?? resolveUrl(name);
      return {
        local_action: "open_app",
        target: name,
        label: name,
        ...(fallback ? { fallback } : {}),
        ...(only ? { only } : {}),
        pending: true,
        note:
          only === "folder"
            ? "Proposed only — opens the folder. The user's device confirms first."
            : only === "app"
            ? "Proposed only — opens the app. The user's device confirms first."
            : "Proposed only — tries the app, then a folder, then the website. The user's device confirms first.",
      };
    }
    case "run_shell": {
      const command = (args.command ?? "").trim();
      if (!command) return { error: "no command given" };
      return {
        local_action: "run_shell",
        command,
        target: command, // keep the generic intent shape happy
        label: (args.label ?? "").trim() || command,
        pending: true,
        note: "Proposed only — the user reviews the literal command and taps Run; the bridge re-validates it before executing.",
      };
    }
    case "send_message": {
      const to = (args.to ?? "").trim();
      const message = (args.message ?? "").trim();
      if (!to) return { error: "no recipient given" };
      if (!message) return { error: "no message given" };
      const channel = (args.channel ?? null) as Channel | null;
      // Default WhatsApp to auto-send (the user opted into bridge auto-Enter);
      // set WHATSAPP_AUTO_SEND=0 to fall back to pre-fill-only.
      const autoSendWhatsApp = !/^(0|false|no|off)$/i.test(
        process.env.WHATSAPP_AUTO_SEND || "1"
      );
      const r = await sendMessage({
        to,
        channel,
        message,
        subject: args.subject ?? null,
        autoSendWhatsApp,
      });
      if (!r.ok) return { error: r.error };
      // WhatsApp can't be sent from the server — return the pending intent the
      // browser confirms and forwards to the local bridge (like open_app).
      if (r.channel === "whatsapp" && "pendingIntent" in r) {
        return {
          ...r.pendingIntent,
          note: "Proposed only — the user's device confirms before sending on WhatsApp.",
        };
      }
      return { sent: true, channel: r.channel, message: r.message };
    }
    case "add_contact": {
      const name = (args.name ?? "").trim();
      if (!name) return { error: "no contact name given" };
      const hasHandle = !!(args.phone || args.telegram || args.email);
      // Always save to the local book first (phone gets the default +65). This is
      // what messaging uses and it works even without a Google account.
      const c = await upsertContact({
        name,
        phone: args.phone ?? undefined,
        telegram: args.telegram ?? undefined,
        email: args.email ?? undefined,
      });
      // Also push to Google Contacts so it shows up there (best-effort). Telegram
      // has no Google field, so only name/phone/email are written.
      const g = await createGoogleContact({ name: c.name, phone: c.phone, email: c.email });
      return {
        saved: c,
        google: g.ok ? { added: true } : { added: false, reason: g.error },
        ...(!hasHandle ? { note: "saved without any contact handle yet" } : {}),
      };
    }
    case "list_contacts": {
      const remove = (args.remove ?? "").trim();
      if (remove) {
        const ok = await deleteContact(remove);
        return ok ? { deleted: remove } : { error: `no contact called “${remove}”` };
      }
      const book = await listContacts();
      return {
        count: book.length,
        contacts: book.map((c) => ({
          name: c.name,
          channels: [
            c.phone ? "whatsapp" : null,
            c.telegram ? "telegram" : null,
            c.email ? "email" : null,
          ].filter(Boolean),
        })),
      };
    }
    case "sync_contacts": {
      const source = (args.source ?? "all") as "google" | "telegram" | "all";
      const out: Args = {};
      if (source === "google" || source === "all") {
        const g = await importGoogleContacts();
        out.google = g.ok
          ? { imported: g.imported, skipped: g.skipped, accounts: g.accounts }
          : { error: g.error };
      }
      if (source === "telegram" || source === "all") {
        if (!isTelegramUserConfigured()) {
          out.telegram = {
            error:
              "Telegram user account isn't set up — run `npm run telegram:login` first.",
          };
        } else {
          const t = await importTelegramContacts();
          out.telegram = t.ok
            ? { imported: t.imported, skipped: t.skipped }
            : { error: t.error };
        }
      }
      return out;
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// Shared email matcher: pulls summaries (optionally urgency-filtered) and
// narrows by free-text query against sender/subject/summary.
async function matchEmails({
  query,
  minUrgency,
  unreviewedOnly,
  date,
}: {
  query?: string | null;
  minUrgency?: number | null;
  unreviewedOnly?: boolean | null;
  date?: string;
}): Promise<Summary[]> {
  let res = await listSummaries({
    ...(minUrgency ? { urgency: String(minUrgency) } : {}),
    ...(date ? { date } : {}),
  });
  const q = (query ?? "").trim().toLowerCase();
  if (q) {
    res = res.filter(
      (s) =>
        s.from.toLowerCase().includes(q) ||
        s.subject.toLowerCase().includes(q) ||
        s.summary.toLowerCase().includes(q)
    );
  }
  if (unreviewedOnly) res = res.filter((s) => !s.reviewed);
  return res;
}
