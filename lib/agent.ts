import { desc, eq } from "drizzle-orm";
import {
  parseRateLimits,
  classifyRateLimit,
  parseDailyUsage,
  sleep,
  type RateLimits,
} from "./groq";
import { runTool, toolDefs, CLOUD_TOOLS, ALL_GROUPS, type GroupKey } from "./tools";
import { recordRateLimit } from "@/lib/mail/blobs";
import { db, tasks, events, notes, projects } from "@/db";
import { refOf } from "./refs";
import { createCompletion } from "./llm";
import { modelById, type ModelDef } from "./models";
import { computeModelStatus } from "./model-status";
import { getMemory, renderMemoryMarkdown } from "./memory";

// The user's "about me" facts as a markdown block for the cloud prompt. Best-effort
// — a DB failure returns "" so a turn never breaks over missing memory.
async function getMemoryBlock(): Promise<string> {
  try {
    return renderMemoryMarkdown(await getMemory());
  } catch {
    return "";
  }
}

// Compact snapshot of current data so the model knows what actually exists
// (and whether a name like "meeting" is a task or an event). Each line carries
// the item's short ref (t5/e2/n3) so the model can target it exactly.
async function buildSnapshot(includeHistory = true): Promise<string> {
  const [openTasks, openEvents, recentNotes, allProjects, doneTasks, doneEvents] =
    await Promise.all([
      db
        .select({ seq: tasks.seq, title: tasks.title, dueDate: tasks.dueDate })
        .from(tasks)
        .where(eq(tasks.done, false))
        .orderBy(desc(tasks.createdAt))
        .limit(12),
      db
        .select({
          seq: events.seq,
          title: events.title,
          startTime: events.startTime,
          recurrence: events.recurrence,
          projectId: events.projectId,
        })
        .from(events)
        .where(eq(events.done, false))
        .orderBy(desc(events.createdAt))
        .limit(12),
      db
        .select({ seq: notes.seq, title: notes.title, body: notes.body })
        .from(notes)
        .orderBy(desc(notes.createdAt))
        .limit(10),
      db
        .select({
          id: projects.id,
          seq: projects.seq,
          title: projects.title,
          improvements: projects.improvements,
          done: projects.done,
        })
        .from(projects)
        .orderBy(desc(projects.createdAt))
        .limit(10),
      // History is only needed for undo/restore/delete-from-history — skip the
      // two extra queries (and their tokens) otherwise.
      includeHistory
        ? db
            .select({ seq: tasks.seq, title: tasks.title })
            .from(tasks)
            .where(eq(tasks.done, true))
            .orderBy(desc(tasks.createdAt))
            .limit(8)
        : Promise.resolve([] as { seq: number; title: string }[]),
      includeHistory
        ? db
            .select({ seq: events.seq, title: events.title })
            .from(events)
            .where(eq(events.done, true))
            .orderBy(desc(events.createdAt))
            .limit(8)
        : Promise.resolve([] as { seq: number; title: string }[]),
    ]);

  const fmt = (d: Date | null) =>
    d
      ? new Intl.DateTimeFormat("en-CA", {
          timeZone: TZ,
          dateStyle: "short",
          timeStyle: "short",
        }).format(d)
      : "no date";

  const taskLines = openTasks.length
    ? openTasks
        .map((t) => `  ${refOf("task", t.seq)}: "${t.title}" (due ${fmt(t.dueDate)})`)
        .join("\n")
    : "  (none)";
  const projectSeqById = new Map(allProjects.map((p) => [p.id, p.seq]));
  const eventLines = openEvents.length
    ? openEvents
        .map((e) => {
          const projSeq = e.projectId ? projectSeqById.get(e.projectId) : undefined;
          const projTag = projSeq ? `, time for ${refOf("project", projSeq)}` : "";
          return `  ${refOf("event", e.seq)}: "${e.title}" (${fmt(e.startTime)}${
            e.recurrence !== "none" ? `, repeats ${e.recurrence}` : ""
          }${projTag})`;
        })
        .join("\n")
    : "  (none)";
  const noteLines = recentNotes.length
    ? recentNotes
        .map((n) => {
          const text = (n.title ? `${n.title}: ` : "") + (n.body ?? "");
          const trimmed = text.length > 40 ? `${text.slice(0, 40)}…` : text;
          return `  ${refOf("note", n.seq)}: "${trimmed}"`;
        })
        .join("\n")
    : "  (none)";
  const openProjects = allProjects.filter((p) => !p.done);
  const projectLines = openProjects.length
    ? openProjects
        .map((p) => {
          const imps = p.improvements ?? [];
          // Keep every improvement's NUMBER (so edit/remove-by-number still works)
          // but cap each one's text — the full text comes back via list_projects.
          const list = imps.length
            ? imps
                .map((t, i) => {
                  const s = t.length > 50 ? `${t.slice(0, 50)}…` : t;
                  return `      ${i + 1}. ${s}`;
                })
                .join("\n")
            : "      (no improvements yet)";
          return `  ${refOf("project", p.seq)}: "${p.title}"\n${list}`;
        })
        .join("\n")
    : "  (none)";
  const historyLines = [
    ...doneTasks.map((t) => `  ${refOf("task", t.seq)}: "${t.title}"`),
    ...doneEvents.map((e) => `  ${refOf("event", e.seq)}: "${e.title}"`),
    ...(includeHistory
      ? allProjects
          .filter((p) => p.done)
          .map((p) => `  ${refOf("project", p.seq)}: "${p.title}"`)
      : []),
  ];
  // Omit the HISTORY section entirely when not requested (saves tokens).
  const historySection =
    includeHistory && historyLines.length
      ? `\nHISTORY (already completed; can be undone or deleted):\n${historyLines.join("\n")}`
      : "";

  return `\nThe user's CURRENT data. Each item has a ref ("Task 5", "Event 2", "Note 3"). To update/delete/undo an item, pass its ref — do NOT guess. A name may be a TASK or an EVENT; the ref word tells you which.\nOPEN TASKS:\n${taskLines}\nEVENTS:\n${eventLines}\nNOTES:\n${noteLines}\nPROJECTS (each lists its numbered improvements):\n${projectLines}${historySection}\n`;
}

// Try each model in turn. A 429 is one of two very different things:
//   • per-DAY quota  → that model is really out; mark exhausted, fall through.
//   • per-MINUTE cap → transient; the bucket refills in seconds. We retry the
//     same model once after the short wait Groq suggests (bounded), and we do
//     NOT mark it exhausted (so the UI doesn't falsely show it as "limited").
async function complete(
  messages: any[],
  exhausted: Set<string>,
  tools: any[],
  models: ModelDef[],
  maxTokens = 1024
) {
  let lastErr: any;
  let usedRetry = false; // one short wait per call, to bound latency
  // The keyword router (selectTools) sends only a subset of tools to keep
  // requests small. If a model tries to call a real tool we DIDN'T send, Groq
  // 400s with tool_use_failed. We then widen to the full toolset and retry the
  // same model once, so a mis-routed request self-heals instead of failing.
  let activeTools = tools;
  let widened = false;
  // One-line routing trace so the server logs show exactly which model each
  // turn landed on and why it rotated. Mirrors what the on-screen HUD shows.
  console.log(
    `[route] chain: ${models.map((m) => (exhausted.has(m.id) ? `(${m.id} out)` : m.id)).join(" → ")}`
  );
  for (const model of models) {
    if (exhausted.has(model.id)) continue;
    // up to 2 attempts on this model (the 2nd only after a brief per-minute wait)
    for (;;) {
      try {
        console.log(`[route] → trying ${model.provider}/${model.id}`);
        // Chat mode sends no tools — omit the tool fields entirely (providers
        // reject an empty tools array with tool_choice "auto").
        const useTools = activeTools && activeTools.length > 0;
        const { completion, headers } = await createCompletion(model, {
          messages,
          ...(useTools ? { tools: activeTools, tool_choice: "auto" as const } : {}),
          temperature: 0.2,
          // Cap output to avoid runaway completions (esp. reasoning models).
          max_tokens: maxTokens,
        });
        console.log(
          `[route] ✓ ${model.id} answered (${completion?.usage?.total_tokens ?? "?"} tok)`
        );
        return {
          completion,
          model: model.id,
          usage: completion.usage,
          limits: parseRateLimits(headers),
        };
      } catch (err: any) {
        if (err?.status === 429) {
          lastErr = err;
          const { scope, retryMs } = classifyRateLimit(err);
          // Capture the truth a provider only exposes on a 429 (authoritative
          // daily usage + live ceilings) so the dashboard reflects reality.
          try {
            const daily = parseDailyUsage(err);
            const headerLimits = err?.headers
              ? parseRateLimits(new Headers(err.headers as Record<string, string>))
              : undefined;
            void recordRateLimit(model.id, {
              limits: headerLimits,
              dailyUsed: daily?.used,
              dailyLimit: daily?.limit,
              dailyResetMs: scope === "day" ? retryMs : null,
            });
          } catch {
            /* recording is best-effort */
          }
          if (scope === "day") {
            console.log(`[route] ✗ ${model.id} daily quota spent — rotating`);
            exhausted.add(model.id); // real daily quota — skip this model
            break;
          }
          console.log(`[route] ⏭ ${model.id} rate-limited (per-min) — next model`);
          // per-minute / unknown: retry this same model once if the wait is short
          if (!usedRetry && retryMs != null && retryMs <= 3000) {
            usedRetry = true;
            await sleep(retryMs + 200);
            continue;
          }
          break; // transient but no time to wait — try the next model
        }
        // Malformed tool call (smaller models sometimes emit broken syntax).
        if (err?.code === "tool_use_failed" || /tool_use_failed/i.test(err?.message || "")) {
          lastErr = err;
          // Case: the model tried a REAL tool we didn't route to it
          // ("not in request.tools"). Widen to every tool and retry this same
          // model once before giving up on it.
          const failMsg = `${err?.message ?? ""} ${err?.error?.message ?? ""} ${
            err?.error?.failed_generation ?? ""
          }`;
          const wanted = failMsg.match(/['"`]?name['"`]?\s*:?\s*['"`]([a-z_]+)['"`]|tool ['"`]([a-z_]+)['"`]/i);
          const toolName = wanted?.[1] || wanted?.[2];
          const known = toolName && toolDefs.some((d) => d.function.name === toolName);
          const alreadySent =
            toolName && activeTools.some((d: any) => d.function.name === toolName);
          if (!widened && known && !alreadySent) {
            widened = true;
            activeTools = tools;
            continue; // retry same model with the full enabled toolset
          }
          break;
        }
        // Model unavailable/decommissioned/unknown id (404/400). Don't let one
        // stale entry in FALLBACK_MODELS kill the request — skip it and rotate
        // to the next model, so the rotation list is safe to expand freely.
        const msg = err?.error?.message ?? err?.message ?? "";
        if (
          err?.status === 404 ||
          err?.status === 400 ||
          /decommission|not found|does not exist|unknown model|invalid model|no longer/i.test(msg)
        ) {
          console.log(`[route] ⊘ ${model.id} unavailable/decommissioned — skip`);
          lastErr = err;
          exhausted.add(model.id);
          break;
        }
        throw err;
      }
    }
  }
  throw lastErr;
}

const TZ = process.env.ASSISTANT_TIMEZONE || "Asia/Singapore";

// Reasoning models (qwen3, gpt-oss) sometimes emit a <think>…</think> block — or
// an UNclosed one — in the message content. Strip it so chain-of-thought is never
// shown or read aloud. If that leaves nothing, the caller falls back to a tool
// message instead of speaking the raw monologue.
function cleanReply(s?: string | null): string {
  return (s || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/i, "") // unclosed think dump
    .replace(/<\/?(think|reasoning|analysis)>/gi, "")
    .trim();
}

// Hard cap on the spoken reply length. The prompts ask for ≤20 words, but models
// sometimes run long, so we also enforce it here as a guarantee (it's read aloud).
const MAX_REPLY_WORDS = 20;
function clampWords(s: string, max = MAX_REPLY_WORDS): string {
  const words = s.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return s.trim();
  // Trim to the cap, drop a trailing comma, and end with an ellipsis.
  return words.slice(0, max).join(" ").replace(/[,;:]$/, "") + "…";
}

// Domain rule blocks, included only when the request activates that group, so a
// "play a song" request doesn't pay for the email/local rules and vice-versa.
const RULES_EMAIL = `- EMAIL: the user has a connected Gmail summarized by MailMind. For a DIGEST/SUMMARY request ("what's my digest", "read my email summary", "email digest", "today's emails"), call fetch_emails_now AND list_emails (with today_only=true — this matches the Digest tab) together in the SAME turn, fetch first, and read the result. NEW/RECENT is different: for "what's new", "any new emails", "recent emails", "fetch/check/refresh my email" call ONLY fetch_emails_now — it returns just the emails that arrived SINCE THE LAST FETCH; read them back, and if new_emails is 0 say plainly "No new emails." (So the first ask of the day shows what arrived; asking "new" again right after says nothing new.) Use list_emails to read stored summaries — for "read my email summary"/"email digest" call it with no filter; for "urgent emails" set min_urgency=4; for "the recent/latest urgent email" set min_urgency=4 and limit=1; to look up a sender or company (e.g. "emails from KrisFlyer") set query to that name. Read back the sender, subject, and summary naturally. Use mark_emails_reviewed to mark mail reviewed: all=true for "mark all as reviewed", or query=<sender/keyword> for specific ones. For "the latest fetched email" call list_emails with order="recent" and limit=1.`;

const RULES_LOCAL = `- WEB ACTIONS: to READ or SUMMARIZE a page's CONTENT ("summarize the X website", "read me espn.com", "what does <site> say") => read_site (mode "summarize" or "read"). This does NOT open a browser — it fetches the page and reads it back. Only for public pages. Opening apps, folders, or websites on the user's own computer is handled by the local computer assistant, not here — do NOT try to open them. Only call read_site, and only when the user clearly wants to read or summarize a page.`;

const RULES_MESSAGE = `- MESSAGING PEOPLE (free — send a message TO a person, not a note/reminder): use send_message.
  · \`to\` is a saved contact NAME ("Mom", "Alex") or a raw handle (phone number, @username, or email). Pass exactly what the user said; the system resolves saved contacts.
  · \`channel\`: set it from how the user phrased it — "text/whatsapp/message X" => "whatsapp"; "telegram/DM X" => "telegram"; "email X" => "email". If they didn't say, OMIT channel and the system picks from what the contact has.
  · \`message\` is the body to send. Phrase it naturally as the user intends (e.g. "tell Mom I'll be home by 8" => message "I'll be home by 8"). For email you may add a short \`subject\`.
  · Telegram and email are sent immediately — report success plainly. WhatsApp opens on the user's own computer and is CONFIRMED first, so say something like "Okay, I'll message Mom on WhatsApp if you confirm."
  · To save someone for later, use add_contact (name plus any of phone/telegram/email). Use list_contacts to read them back, or list_contacts with remove=<name> to delete one.
  · "Import/sync my contacts", "load my Google/Telegram contacts" => sync_contacts (source "google", "telegram", or "all"). Report back how many were imported. After importing, the user can message those people by name.
  · If a send fails because a channel isn't set up or the contact has no matching handle, read the error back plainly and suggest adding the detail.`;

const RULES_SPOTIFY = `- SPOTIFY PLAYBACK (Premium, plays immediately — NOT a confirm-first local action):
  · play_spotify with the right type: a song => type "track"; "play some <artist>" => type "artist"; "play the album X" => "album"; "play my/the playlist X" => "playlist". It really starts the music.
  · queue_spotify for "queue X", "play X next", "add X to the queue".
  · spotify_control for ongoing playback: pause, resume, next, previous, now_playing; volume (pass volume 0-100; "turn it up/down" => pick a sensible level); shuffle_on/shuffle_off; repeat_off/repeat_one/repeat_all; save ("save/like this song" — no need to name it, it saves what's playing); restart; seek (pass seconds, e.g. "skip to 1 minute" => 60); transfer (pass device, e.g. "play on my phone").
  · If a result says no active device, tell the user to open Spotify first. Report the tool's message back in one natural sentence.`;

// The big STATIC prefix (persona + core task/event/note rules). Identical on
// every request, so Groq's automatic prompt caching reuses it (50% off the
// cached prefix). Volatile content (date, data snapshot) goes at the END.
const CORE_PROMPT = `You are a personal assistant managing the user's tasks, calendar events, and notes.

Rules:
- ALWAYS respond in English, no matter what language the user spoke in.
- To update or delete something, FIND it in the CURRENT data below and pass its "ref" (e.g. "Task 3", "Event 2", "Note 4") to the matching tool. The ref's word tells you whether it is a task, event, or note — call update_task/delete_task, update_event/delete_event, or delete_note accordingly. The user may speak it loosely ("delete task three", "remove note 4") — map it to the matching ref. Only fall back to a title match if the item is not in the list and the user did not say a ref.
- To mark a task complete call update_task with done=true; to mark an event complete call update_event with done=true. Completed items move to the user's History.
- "complete all tasks", "mark all events done", or "complete all projects" => call complete_all with the right target ("tasks", "events", or "projects"). Bulk actions must name which kind — never assume a target the user didn't say.
- To DELETE in bulk ("delete all events", "delete all my tasks", "clear all notes", "delete all projects") => call delete_all with target "tasks", "events", "notes", or "projects". This removes items whether or not they are completed/marked. Only set status="completed" if the user explicitly says "completed"/"done" ones (or "open" for not-done); otherwise omit it to delete them all. To delete a SINGLE named item, use delete_task/delete_event/delete_note/delete_project instead — those also work on completed items.
- To UNDO/restore/reopen an item ("undo Task 9", "restore Event 2"), call update_task or update_event with done=false. This only makes sense for items in HISTORY; if the named item is NOT in History (it's already open), do nothing and say it isn't completed.
- Delete works on any item, including ones in History. "Delete Task 9" removes it whether it is open or completed.
- If the user explicitly names a ref like "Task 9", use that ref even if it is not shown below (it may be completed). Otherwise never invent refs.
- "Move/reschedule X to <time>": if X is an event, update_event with new start/end; if X is a task, update_task with a new due_date. Use the CURRENT data to decide which.
- Time: convert 12-hour speech to 24-hour. "7 pm" = 19:00, "7 am" = 07:00, "noon" = 12:00. Always include the ${TZ} timezone offset in the ISO string, NOT a "Z"/UTC time.
- Things the user must DO are tasks. Things at a specific time are calendar events. Reminders without a clear time become tasks with a due date.
- "Every Monday / every day / monthly" means a recurring event: set recurrence accordingly and put start_time on the correct first occurrence (e.g. the next Monday).
- To move/reschedule an event ("move gym to 8pm", "push the meeting to Friday"), use the event's ref from the CURRENT data and call update_event directly with the new time — do not list first.
- Make ALL the tool calls a request needs in a SINGLE turn (you can emit several at once). Do not wait to call one tool before another.
- PROJECTS: a project is a card the user collects "improvements" (notes) on, and can schedule time for. "Create/start a project X" => create_project. "Add an improvement/idea to project X" or "note that ..." about a project => update_project with add_improvement. "Edit/change improvement N of project X" => update_project with edit_improvement_number + edit_improvement_text; "remove improvement N" => update_project with remove_improvement_number; "rename project X" => update_project with new_title. "Complete/finish project X" => update_project with done=true (and "reopen/undo project X" => done=false); completed projects move to History. "What are my projects", "read/summarize project X" => list_projects (omit ref for ALL; the improvements are numbered in the snapshot). "Delete project X" => delete_project. A project's scheduled TIME is handled by ONE tool, project_time, with action "add" (block out a new time: "add time to project X tomorrow 3pm"), "reschedule" (move an existing time: "move project X's time to Friday"), or "cancel" (remove a time: "cancel project X's time"). Pass the project's ref and a start_time; end_time is OPTIONAL — omit it when the user only gives a start (it defaults to one hour later / keeps the existing length). Only pass event_ref (the "time for Project N" event shown in EVENTS) if the project has more than one time. Do NOT use update_event/delete_event for a project's time — use project_time.
- To answer "what do I have today / what's next / this week", call list_events AND list_tasks first, then answer from the results.
- The calendar holds three kinds of items: plain calendar EVENTS, PROJECT EVENTS (events tied to a project — list_events marks these kind:"project_event"), and TASKS that have a due date ("task events"). When the user asks for "all my events" / "everything on my calendar", call BOTH list_events AND list_tasks and read back all three kinds, noting which events are project events.
- To answer "what are my notes / tasks / events" (or "everything"), call list_tasks, list_events (use a wide range like the next 60 days), and search_notes with an empty query as needed, then read back EVERY item the user asked about — do not summarise or skip any.
- To edit a note's text ("update/change Note 4 to ..."), use update_note and put the new wording in the "body" field — the body is the note's visible text. Do NOT use "title" unless the user literally says "title". To add a brand-new note, use create_note.
- If the user says "cancel", "stop", "never mind", or "forget it" without a real request, do nothing and reply "Okay, cancelled." Do not call any tools.
- If a question has MULTIPLE parts (e.g. "what's my task today and lunch on Monday"), make a separate tool call for each part with the correct date range, then answer every part. For a named weekday like "Monday", compute that specific date's range (00:00 to 23:59).
- Recurring events only appear in list_events when the queried range covers an occurrence, so use the actual target date range, not just today.
- When calling a tool, only include parameters you actually have a value for; omit the rest. Never put extra commentary in arguments.
- After doing the work, reply in ONE short, natural spoken sentence, as concise as possible. It will be read aloud, so no markdown, lists, or IDs. Be brief even when reading items back — name them tersely, don't elaborate.
- Never invent data. If a query returns nothing, say so plainly.`;

// Strict routing means: when no ability/function keyword matched, we send NO
// tools at all (no core toolset, no fuzzy fallback). The model replies naturally
// — small talk gets a friendly reply, and a clear but unsupported/unrecognized
// command is declined plainly.
const CHAT_PROMPT = `You are JARVIS, the user's friendly personal assistant. Reply naturally and briefly, in ONE short spoken English sentence, as concise as possible (no markdown, lists, or IDs — it's read aloud). If they ask the date or time, answer from the "Current date/time" line below — that is authoritative, do NOT use any other date. If it's small talk, just chat warmly. If they asked you to DO something but no tool is available for it right now, say briefly that you can't do that one yet. Never pretend to have done anything, and do NOT call any tools.`;

// The current local date/time line — TZ-correct (Asia/Singapore by default). Used
// to ground chat replies so "what's the date?" never answers from stale training.
function dateLine(): string {
  const now = new Date();
  const localNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);
  return `Current date/time: ${localNow} (timezone ${TZ}).`;
}

// Group keyword matched but no specific action — ask which one. Built per request
// so it names the actual group and its available actions.
function clarifyPrompt(label: string, options: string[]): string {
  return `You are JARVIS, the user's friendly personal assistant. The user referred to "${label}" but didn't say which specific action they want. In ONE short spoken English sentence (no markdown, lists, or IDs — it's read aloud), ask them to specify which one they mean${
    options.length ? ` — for example: ${options.join(", ")}` : ""
  } — or to phrase it with the keyword for that action. Do NOT pretend to do anything, and do NOT call any tools.`;
}

// Slim persona for pure-domain requests (music/email/open/search/messaging) that
// don't touch tasks/events/notes — they don't need the big task/event/note
// rulebook, just enough to drive the one domain tool. Saves ~1k tokens/request.
const SLIM_CORE = `You are JARVIS, the user's personal assistant. Use the given tool(s) to do exactly what the user asked.
Rules:
- ALWAYS respond in English.
- When a time is involved, convert 12-hour speech to 24-hour and include the ${TZ} offset.
- Only include tool parameters you actually have a value for; never put extra commentary in arguments.
- If the user says "cancel" / "never mind", do nothing.`;

// Tiny prompt for the spoken-reply pass (replaces replaying the whole prompt+
// tools just to phrase a sentence). Fed only the user's words + tool results.
const summarySys = (maxWords: number) =>
  `You are JARVIS, a warm, concise personal assistant. Reply with ONLY one short, natural spoken English sentence of AT MOST ${maxWords} words stating what happened — no analysis, no reasoning, no preamble, no markdown, lists, IDs, or quotes (it is read aloud). Trust the results exactly as given; do NOT second-guess or comment on whether they look right. If a result has an "error" field, briefly say it didn't work. If a result is a proposed action awaiting confirmation (pending: true), say you'll do it once they confirm, naming its label. If results list items the user asked for, read them back tersely and stay within ${maxWords} words.`;

// Productivity tools (tasks/events/notes). A request using none of these is
// "pure domain" and gets the slim persona above.
const PRODUCTIVITY_TOOLS = new Set([
  "create_task", "update_task", "delete_task", "complete_all", "list_tasks",
  "create_event", "update_event", "delete_event", "list_events",
  "create_note", "search_notes", "update_note", "delete_note", "delete_all",
  "create_project", "list_projects", "update_project", "delete_project", "project_time",
]);

// Editing/deleting a project may actually mean changing its scheduled TIME, so
// when one of these is routed we also send project_time (the single add/
// reschedule/cancel tool). That lets the model redirect to a time op without a
// full-toolset widen — e.g. "edit the project time" routes to update_project but
// is really a project_time reschedule.
const PROJECT_EDIT_TOOLS = new Set(["update_project", "delete_project"]);

// A digest/summary read of email: we guarantee it pulls NEW mail first, then
// lists today's — done deterministically (not left to the model's single turn),
// and only for digest-style phrasing, not a sender lookup like "email from X".
function isEmailDigest(text: string, route: { tools: string[] }): boolean {
  if (!route.tools.includes("list_emails")) return false;
  // "new"/"recent" route to fetch_emails_now (incremental), NOT the full digest.
  return /\b(digest|summary|summarize|inbox|today)\b/i.test(text);
}

function summarizeActions(actions: AgentResult["actions"]): string {
  return actions
    .map((a) => `- ${a.name}: ${JSON.stringify(a.result).slice(0, 1500)}`)
    .join("\n");
}

// A spoken reply built straight from tool results — used for deterministic
// preset calls (no LLM) whose results already carry a clean `message`/`error`
// (e.g. spotify_control "Paused.", play_spotify). Returns null when any result
// isn't directly speakable (a pending action, or list data needing phrasing),
// so those fall back to the cheap summary pass.
function directReply(actions: AgentResult["actions"]): string | null {
  if (!actions.length) return null;
  const parts: string[] = [];
  for (const a of actions) {
    const r = a.result as { message?: unknown; error?: unknown } | null;
    if (r && typeof r.message === "string" && r.message.trim()) parts.push(r.message.trim());
    else if (r && typeof r.error === "string" && r.error.trim()) parts.push(r.error.trim());
    else return null; // pending action / list result — let the summary pass phrase it
  }
  return parts.join(" ");
}

// If the summary call fails, speak a tool's own message/error rather than "Done."
function fallbackReply(actions: AgentResult["actions"]): string {
  for (let i = actions.length - 1; i >= 0; i--) {
    const r = actions[i].result as { message?: unknown; error?: unknown } | null;
    if (r?.message) return String(r.message);
    if (r?.error) return String(r.error);
  }
  return "Done.";
}

// NOTE: the LOCAL-mode behavior rules (act-don't-announce, the two web paths,
// open-app/open-url local actions, don't-repeat-a-tool-call, talk-like-a-human)
// used to live here as RULES_LOCAL_AGENT / RULES_BROWSER_LOCAL. They now live in
// the user-editable behavior.md, injected by lib/ollama-context.ts, so the user
// can tune them in Obsidian. Cloud turns still use RULES_LOCAL below.

async function systemPrompt(opts: {
  text: string;
  groups: Set<GroupKey>;
  userProfile?: string;
  snapshotOverride?: boolean;
  triggerKeyword?: string;
  multi?: boolean;
  slim?: boolean;
  localBrowser?: boolean;
  /** The user's "about me" memory block (shortcuts/logins/startups/notes). Cloud
   *  turns inject it here; LOCAL turns already get it via memory.md in the prep
   *  route, so it's only applied when !localBrowser to avoid double-injection. */
  memory?: string;
}) {
  const { groups, text } = opts;
  const now = new Date();
  const localNow = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    dateStyle: "full",
    timeStyle: "short",
  }).format(now);

  // Domain rule blocks, only when relevant.
  const blocks: string[] = [];
  if (groups.has("email")) blocks.push(RULES_EMAIL);
  // In LOCAL mode the act-now / web-access / local-action guidance comes from the
  // user-editable behavior.md (see lib/ollama-context.ts), so we skip these
  // hardcoded blocks there to avoid duplication. Cloud turns keep them.
  if (
    !opts.localBrowser &&
    (groups.has("local") || groups.has("search") || groups.has("shell"))
  )
    blocks.push(RULES_LOCAL);
  if (groups.has("spotify")) blocks.push(RULES_SPOTIFY);
  if (groups.has("message")) blocks.push(RULES_MESSAGE);
  if (groups.has("shell")) {
    const base = (opts.userProfile || "").trim();
    if (base)
      blocks.push(
        `- The user's DEFAULT folder is \`${base}\`. When they ask to open/find a folder or file by name (e.g. "open internship orders", "open the shirt folder"), build the path under this default folder: \`explorer "${base}\\internship orders"\`. Only use a different location if the user names one (Documents, Desktop, a full C:\\... path). Never guess a username.`
      );
  }
  // Tell the model the keyword(s) are triggers, not content.
  if (opts.multi) {
    blocks.unshift(
      `- The user asked for SEVERAL things in one request (joined by "and"). Do EACH part using the matching tool. The words that selected each action are triggers, not content. You were given the tools for every part — if one of them isn't actually relevant to any part of the request, simply don't call it.`
    );
  } else if (opts.triggerKeyword) {
    blocks.unshift(
      `- The word "${opts.triggerKeyword}" in the request is what selected this action — it's the trigger, not content. Use the rest of the request as the actual content/target, and never put the trigger word itself into a title, body, or search text.`
    );
  }
  const domain = blocks.length ? "\n" + blocks.join("\n") : "";

  // The data snapshot is only needed for task/event/note work — skip it for pure
  // Spotify/email/open/shell/search requests. History only for undo/restore. A
  // keyword-routed request declares whether it needs the snapshot.
  const wantSnapshot =
    opts.snapshotOverride !== undefined
      ? opts.snapshotOverride
      : needsSnapshot(text, groups);
  const wantHistory = /\b(undo|restore|reopen|history|completed|delete)\b/i.test(text);
  const snapshot = wantSnapshot ? await buildSnapshot(wantHistory) : "";

  // Static prefix first (cacheable), volatile context last. Pure-domain requests
  // use the slim persona (no task/event/note rulebook).
  const core = opts.slim ? SLIM_CORE : CORE_PROMPT;
  // The user's own "about me" facts — always read on cloud turns. (Local turns get
  // the same block via memory.md, so skip it here to avoid duplicating it.)
  const memoryBlock =
    !opts.localBrowser && opts.memory?.trim() ? `\n\n${opts.memory.trim()}` : "";
  const tomorrow = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    dateStyle: "full",
  }).format(new Date(now.getTime() + 86_400_000));
  return `${core}${domain}${memoryBlock}

Current date/time: ${localNow} (timezone ${TZ}). Today is ${localNow.split(",").slice(0, 2).join(",")}; TOMORROW is ${tomorrow}. The current ISO instant is ${now.toISOString()}. Resolve relative times ("tomorrow 7pm", "Friday") to full ISO 8601 WITH the ${TZ} offset (never "Z"/UTC). "Tomorrow" means ${tomorrow}, not today.${snapshot}`;
}

// The data snapshot is worth its tokens only when the request might touch
// tasks/events/notes. Pure domain requests (just Spotify/email/open/shell) skip
// it; anything ambiguous (no domain matched) keeps it to stay safe.
const PRODUCTIVITY_RE =
  /\b(task|tasks|to-?do|note|notes|event|events|calendar|reminder|remind|schedule|scheduled|meeting|appointment|due|reschedule|complete|completed|done|mark|delete|remove|undo|restore|everything|today|tomorrow|tonight|week|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|project|projects|improvement|improvements|what do i have|what'?s on|my day|agenda)\b/i;
function needsSnapshot(text: string, groups: Set<GroupKey>): boolean {
  return groups.size === 0 || PRODUCTIVITY_RE.test(text);
}

export type AgentResult = {
  reply: string;
  actions: { name: string; args: any; result: unknown }[];
  model: string; // model that produced the final answer
  models: string[]; // the full fallback chain
  exhausted: string[]; // models that hit their daily limit this request
  usage: { prompt: number; completion: number; total: number }; // Groq tokens this request
  limits: RateLimits; // rate-limit headers from the final model call
  routed: boolean; // true if a keyword matched an ability (false => chat fallback)
  // Routing debug surfaced to the browser console for testing.
  routing: { tools: string[]; multi: boolean; slim: boolean; trigger?: string } | null;
};

// Pre-warm the LLM so the FIRST real request isn't slow. We send tiny throwaway
// completions carrying the STATIC system prefixes to the top working model(s).
// This (a) wakes the serverless function + opens the HTTP connection to the
// provider, and (b) primes the provider's automatic prompt cache for those
// prefixes, so the first genuine request reuses them at a discount instead of
// paying full freight cold. Fire-and-forget; failures are swallowed (a cold first
// request is the worst case, not an error).
//   • CORE_PROMPT (task/event/note/project requests) → top TWO non-exhausted
//     models, so a daily-limit rotation still lands on a warm model.
//   • SLIM_CORE (pure-domain: play/open/search/email/message) → ACTIVE model only
//     (the one a request will actually use next), since it's the shorter prefix
//     and warming both prefixes on two models each is overkill.
export async function warmModels(): Promise<{ warmed: string[] }> {
  try {
    const { models: statuses, exhaustedIds } = await computeModelStatus();
    const seed = new Set(exhaustedIds);
    const working = statuses
      .filter((s) => s.enabled && s.available && !seed.has(s.id))
      .map((s) => modelById(s.id)!)
      .filter(Boolean)
      .slice(0, 2);
    const ping = (model: ModelDef, system: string) =>
      createCompletion(model, {
        messages: [
          { role: "system", content: system },
          { role: "user", content: "ping" },
        ],
        max_tokens: 1,
        temperature: 0,
      });
    // CORE_PROMPT on the top two; SLIM_CORE on the active (first) model only.
    const jobs = [
      ...working.map((m) => ping(m, CORE_PROMPT)),
      ...(working[0] ? [ping(working[0], SLIM_CORE)] : []),
    ];
    await Promise.allSettled(jobs);
    const warmed = working.map((m) => m.id);
    console.log(`[agent] warmed models: [${warmed.join(", ") || "none"}] (+SLIM_CORE on active)`);
    return { warmed };
  } catch {
    return { warmed: [] };
  }
}

// Longform word caps for spoken page read-back — much larger than the 20-word
// reply cap, since the point is to read/summarize actual content aloud.
const SUMMARIZE_WORDS = 90;
const READ_WORDS = 220;

// Shared system prompt + word cap for the read/summarize page pass.
function pagePrompt(mode: string): { sys: string; cap: number } {
  const read = mode === "read";
  const cap = read ? READ_WORDS : SUMMARIZE_WORDS;
  const sys = read
    ? `You are JARVIS reading a web page aloud to the user. From the page content, read back the MAIN article/content in clear, natural spoken English — skip nav, ads, cookie notices, and boilerplate. No markdown, lists, or URLs. Keep it under ${cap} words; if the page is long, read the most important parts.`
    : `You are JARVIS summarizing a web page for the user. Give a clear, natural spoken summary of what the page is about and its key points. No markdown, lists, or URLs. Keep it under ${cap} words.`;
  return { sys, cap };
}

// Build the working model order + pre-seeded exhausted set (same logic runAgent
// uses), for standalone passes like the page-text endpoint.
async function buildModelOrder(): Promise<{ order: ModelDef[]; exhausted: Set<string> }> {
  const { models: statuses, exhaustedIds } = await computeModelStatus();
  const working: ModelDef[] = statuses
    .filter((s) => s.enabled && s.available)
    .map((s) => modelById(s.id)!)
    .filter(Boolean);
  // Fallback when nothing is both enabled AND available right now: prefer the
  // user's ENABLED models (even if currently exhausted/unconfigured) so an
  // unticked model is never silently used. Only as a last resort use the whole
  // registry.
  const enabledOrder = statuses.filter((s) => s.enabled).map((s) => modelById(s.id)!).filter(Boolean);
  const order = working.length
    ? working
    : enabledOrder.length
    ? enabledOrder
    : statuses.map((s) => modelById(s.id)!).filter(Boolean);
  const seed = new Set(exhaustedIds);
  const exhausted = order.every((m) => seed.has(m.id)) ? new Set<string>() : seed;
  return { order, exhausted };
}

// Standalone read/summarize of already-extracted page text — used by the bridge
// path (logged-in pages: /api/page) where the browser, not the server, fetched
// the content. Builds its own model chain.
export async function readPageText(page: {
  content: string;
  title?: string;
  mode?: string;
}): Promise<{ reply: string; usage: { prompt: number; completion: number; total: number }; model: string }> {
  const { order, exhausted } = await buildModelOrder();
  const usage = { prompt: 0, completion: 0, total: 0 };
  let model = order[0]?.id ?? "";
  const reply = await readPageReply(
    { content: page.content, title: page.title ?? "", mode: page.mode ?? "summarize" },
    order,
    exhausted,
    (u) => {
      usage.prompt += u?.prompt_tokens ?? 0;
      usage.completion += u?.completion_tokens ?? 0;
      usage.total += u?.total_tokens ?? 0;
    },
    (m) => { model = m; }
  );
  return { reply, usage, model };
}

// Pick ONE page action from a snapshot tree for a single-step, confirmed click.
// The browser (bridge) provides the pruned element list ("[12] button \"Submit\"");
// the model maps the user's instruction to one element ref + action. Returns the
// chosen action plus a short `say` for the spoken confirmation.
export type PageActionPlan = {
  // "read"/"done" let the CLIENT pump multi-step: it executes the action, then
  // re-plans on the fresh page until the planner says the answer is now readable
  // ("read") or the task is finished ("done").
  act: "click" | "type" | "select" | "check" | "scroll_down" | "scroll_up" | "back" | "enter" | "none" | "read" | "done";
  ref: number | null;
  text: string | null;
  say: string;
};
export async function planPageAction(input: {
  instruction: string;
  tree: string;
  title?: string;
}): Promise<{ plan: PageActionPlan; usage: { prompt: number; completion: number; total: number }; model: string }> {
  const { order, exhausted } = await buildModelOrder();
  const sys = `You control a web page through a list of ELEMENTS, one per line as: [ref] role "name".
Given the user's instruction, choose the NEXT single action toward answering it. Respond with ONLY compact JSON, no prose, no code fences:
{"act":"click|type|select|check|scroll_down|scroll_up|back|enter|read|done|none","ref":<the element's number or null>,"text":<text to type/select or null>,"say":"<short natural phrase describing the action, e.g. 'click the Usage tab'>"}
Rules: pick the element whose role/name best matches the instruction. For typing/searching, set act "type", ref = the input field, text = what to type. Use scroll_down/scroll_up/back/enter (ref null) when navigational.
This may be one step of several — the page is re-snapshotted after each action. When the instruction is a QUESTION or asks to read/summarize/"what is…", and the answer is on the CURRENT page (you don't need to click further), use act "read" (ref null) — the page text will be read to answer. When the task is fully complete and nothing more is needed, use act "done". If nothing on the page matches and you can't proceed, use act "none" and explain in "say". Never invent a ref that isn't in the list.`;
  const nonReasoning = [...order].sort((a, b) => (a.reasoning ? 1 : 0) - (b.reasoning ? 1 : 0));
  const usage = { prompt: 0, completion: 0, total: 0 };
  let model = order[0]?.id ?? "";
  let plan: PageActionPlan = { act: "none", ref: null, text: null, say: "I couldn't work out what to do on that page." };
  try {
    const r = await complete(
      [
        { role: "system", content: sys },
        { role: "user", content: `Instruction: ${input.instruction}\nPage: ${input.title ?? ""}\nElements:\n${input.tree}` },
      ],
      exhausted,
      [],
      nonReasoning,
      300,
    );
    model = r.model;
    usage.prompt += r.usage?.prompt_tokens ?? 0;
    usage.completion += r.usage?.completion_tokens ?? 0;
    usage.total += r.usage?.total_tokens ?? 0;
    const raw = cleanReply(r.completion.choices[0].message.content)
      .replace(/^```(json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      const p = JSON.parse(m[0]);
      const act = String(p.act || "none");
      plan = {
        act: (["click", "type", "select", "check", "scroll_down", "scroll_up", "back", "enter", "read", "done", "none"].includes(act) ? act : "none") as PageActionPlan["act"],
        ref: typeof p.ref === "number" ? p.ref : p.ref != null && !isNaN(Number(p.ref)) ? Number(p.ref) : null,
        text: p.text != null ? String(p.text) : null,
        say: String(p.say || "").slice(0, 120) || "Do this on the page",
      };
    }
  } catch {
    /* keep the default "none" plan */
  }
  return { plan, usage, model };
}

// Turn fetched page text into a spoken summary or read-out. Uses the existing
// model fallback chain (non-reasoning first), with a generous output budget.
async function readPageReply(
  page: { content: string; title: string; mode: string },
  order: ModelDef[],
  exhausted: Set<string>,
  addUsage: (u?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null) => void,
  setMeta: (model: string, limits: RateLimits) => void
): Promise<string> {
  const { sys, cap } = pagePrompt(page.mode);
  // Prefer non-reasoning models so we never speak a chain-of-thought dump.
  const summaryOrder = [...order].sort((a, b) => (a.reasoning ? 1 : 0) - (b.reasoning ? 1 : 0));
  try {
    const sum = await complete(
      [
        { role: "system", content: sys },
        {
          role: "user",
          content: `Page title: ${page.title}\n\nPage content:\n${page.content}`,
        },
      ],
      exhausted,
      [],
      summaryOrder,
      Math.ceil(cap * 2), // ~tokens; comfortably above the word cap
    );
    setMeta(sum.model, sum.limits);
    addUsage(sum.usage);
    const reply = cleanReply(sum.completion.choices[0].message.content);
    if (reply) return clampWords(reply, cap);
  } catch {
    /* fall through */
  }
  return page.mode === "read" ? "I couldn't read that page back." : "I couldn't summarize that page.";
}

// The fully-resolved plan for one turn: which tools to send, the system prompt,
// and the routing metadata. Shared by runAgent (cloud loop) and prepareTurn (the
// client-driven LOCAL loop), so both route identically — only WHO runs the model
// differs (cloud here, the bridge's Ollama in the browser).
type TurnPlan = {
  routed: boolean; // a real action was planned (vs. a pure chat turn)
  groups: Set<GroupKey>;
  tools: any[];
  chat: boolean;
  clarify?: { label: string; options: string[] };
  triggerKeyword?: string;
  multi: boolean;
  multiRound: boolean; // keep looping so the model can chain dependent tools
  slim: boolean;
  presetCalls: { name: string; args: any }[];
  onlyPreset: boolean;
  systemContent: string;
};

async function planTurn(
  userText: string,
  opts?: { userProfile?: string; useSnapshot?: boolean; allTools?: boolean; enabledTools?: string[] }
): Promise<TurnPlan> {
  const useSnapshot = opts?.useSnapshot !== false;
  // FULLY MODEL-DRIVEN (set 2026-06-13): there is NO deterministic routing on any
  // path — no keyword router, no presets, no slim/clarify gating, no browser-intent
  // matcher. Every turn hands the model the ENABLED tool schema + the full persona
  // + the data snapshot (when the turn needs it) and lets IT decide every call,
  // including chaining tools across rounds. The old resolveRequest()/simplePreset()
  // pipeline (lib/abilities.ts) is no longer used by voice.
  //   • CLOUD path (this server loop): tools = CLOUD_TOOLS (no browser_* — the
  //     cloud can't drive the local browser), then narrowed to the enabled set.
  //   • LOCAL path (opts.allTools, client loop): tools = the enabled set including
  //     the agentic browser_* tools, which the client dispatches to the bridge.
  // Both run inference through the same rotating /v1 key pool.
  const smart = !opts?.allTools;

  let groups: Set<GroupKey>;
  let tools: any[];
  let chat = false;
  let triggerKeyword: string | undefined;
  let multi = false;
  let snapshotOverride: boolean | undefined; // undefined => needsSnapshot decides
  let slim = false;
  let clarify: { label: string; options: string[] } | undefined;

  if (smart) {
    groups = new Set<GroupKey>(ALL_GROUPS);
    // ONLY the user's enabled tools (the deck's tool-picker) are given to the
    // model — same rule as the local path. We start from CLOUD_TOOLS (the agentic
    // browser_* tools are excluded because the cloud server can't drive the local
    // browser) and keep just the enabled ones. No picker list sent => full set.
    const allow = Array.isArray(opts?.enabledTools) ? new Set(opts!.enabledTools) : null;
    tools = allow ? CLOUD_TOOLS.filter((d) => allow.has(d.function.name)) : CLOUD_TOOLS;
  } else {
    // LOCAL all-tools mode — the toolset is built in the dedicated block below.
    groups = new Set<GroupKey>();
    tools = [];
  }

  console.log(
    `[agent] "${userText}" => ${
      smart ? `SMART cloud — ${tools.length} enabled tools, model decides` : "LOCAL all-tools"
    }`
  );

  // The model drives every call now — no deterministic preset bypass anywhere.
  // The CLOUD path is narrowed by the same enabled tool allow-list as local
  // (browser_* excluded because the server cannot drive the user's browser).
  let presetCalls: { name: string; args: any }[] = [];

  // LOCAL "all tools" mode: a local model runs on the user's own GPU with no
  // token budget to protect, so give it the ENTIRE toolset + all domain rules and
  // let IT decide every call — including open/play/lists/read, which the cloud
  // path short-circuits to deterministic presets to save tokens. Every preset can
  // also be reached as a real tool (delete_all/complete_all included), so dropping
  // the presets loses no capability. Web access is BROWSER-ONLY here: the search
  // tools (search_web/web_search) are removed so the model reaches the web by
  // driving the user's real browser (open → snapshot → read/act), per
  // RULES_BROWSER_LOCAL. Only a pure clarify turn is left to ask.
  if (opts?.allTools && !clarify) {
    chat = false;
    slim = false;
    multi = false;
    triggerKeyword = undefined;
    // Local toolset. The web-search tools (search_web / web_search) and the
    // open_url duplicate have been removed entirely — the local agent reaches the
    // web by driving the user's real browser (browser_open → snapshot → read/act),
    // and open_app handles real app/folder NAMES ("open Spotify", "open my chip
    // folder"); behavior.md tells it URLs go to browser_open. No presets here.
    if (Array.isArray(opts?.enabledTools)) {
      // User-curated LOCAL toolset (the check/uncheck UI on the deck). EXACTLY the
      // tools the user enabled go into the schema — including the agentic browser
      // tools, which the client loop dispatches to the bridge itself. An empty
      // list means the user unchecked everything → no tools (NOT the full set).
      const allow = new Set(opts!.enabledTools);
      tools = toolDefs.filter((d) => allow.has(d.function.name));
    } else {
      tools = toolDefs;
    }
    groups = new Set<GroupKey>(ALL_GROUPS);
    snapshotOverride = undefined; // let needsSnapshot decide
    presetCalls = []; // the model drives every call now — no deterministic bypass
  }

  const onlyPreset = presetCalls.length > 0 && tools.length === 0 && !chat;

  const systemContent = clarify
    ? clarifyPrompt(clarify.label, clarify.options)
    : chat
    ? `${CHAT_PROMPT}\n\n${dateLine()}`
    : onlyPreset
    ? "" // no model tool pass — preset calls run directly below
    : await systemPrompt({
        text: userText,
        groups,
        userProfile: opts?.userProfile,
        triggerKeyword,
        multi,
        // The user's "about me" facts (cloud injects here; local gets it via
        // memory.md). Best-effort: a DB read failure just omits the block.
        memory: opts?.allTools ? undefined : await getMemoryBlock(),
        // Local all-tools mode → browser-first web access (no search tool).
        localBrowser: opts?.allTools === true,
        // Force the snapshot off when the user disabled it; otherwise keep the
        // per-route decision (undefined => auto).
        snapshotOverride: useSnapshot ? snapshotOverride : false,
        slim,
      });

  return {
    routed: !chat,
    groups,
    tools,
    chat,
    clarify,
    triggerKeyword,
    multi,
    // Do not reload the full enabled tool schema after a tool batch just to
    // speak a summary. The summary pass below sends [] tools and only the tool
    // results. Local keeps its own client loop.
    multiRound: false,
    slim,
    presetCalls,
    onlyPreset,
    systemContent,
  };
}

// The system prompt + tool defs for a turn, handed to the CLIENT so it can run
// the same turn against a LOCAL model via the bridge (Vercel can't reach the
// bridge; only the browser can). The client runs the tool-calling loop and posts
// each tool call back to /api/agent/tool to execute it against the cloud DB.
// Mirrors runAgent's routing exactly via the shared planTurn.
export async function prepareTurn(
  userText: string,
  opts?: { userProfile?: string; useSnapshot?: boolean; allTools?: boolean; enabledTools?: string[] }
): Promise<{
  system: string;
  tools: any[];
  chat: boolean;
  onlyPreset: boolean;
  presetCalls: { name: string; args: any }[];
  routing: AgentResult["routing"];
}> {
  const plan = await planTurn(userText, opts);
  return {
    system: plan.systemContent,
    tools: plan.tools,
    chat: plan.chat,
    onlyPreset: plan.onlyPreset,
    presetCalls: plan.presetCalls,
    routing: plan.routed
      ? {
          tools: plan.tools.map((t: any) => t.function.name),
          multi: plan.multi,
          slim: plan.slim,
          trigger: plan.triggerKeyword,
        }
      : null,
  };
}

// Runs a tool-calling loop until the model produces a final spoken reply.
export async function runAgent(
  userText: string,
  opts?: { userProfile?: string; maxWords?: number; useSnapshot?: boolean; enabledTools?: string[] }
): Promise<AgentResult> {
  // Spoken-reply word cap (adjustable from the JARVIS page); clamp to a sane range.
  const maxWords = Math.max(5, Math.min(60, opts?.maxWords || MAX_REPLY_WORDS));
  // The data snapshot (current items + refs) can be turned off from the JARVIS
  // page to save tokens; when off we never attach it (name-based edits get less
  // precise, but list/ref-based ones still work).
  const useSnapshot = opts?.useSnapshot !== false;
  const {
    routed,
    groups,
    tools,
    chat,
    triggerKeyword,
    multi,
    multiRound,
    slim,
    presetCalls,
    onlyPreset,
    systemContent,
  } = await planTurn(userText, {
    userProfile: opts?.userProfile,
    useSnapshot,
    enabledTools: opts?.enabledTools,
  });
  void groups;
  const messages: any[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userText },
  ];

  // Build the working fallback chain: only the user's ENABLED + available models,
  // in registry order (Gemini first). Pre-seed `exhausted` with models whose
  // daily quota is currently spent so we skip straight to the next one. If that
  // would leave nothing to try (everything looks exhausted), start fresh and let
  // them be re-attempted — a reset may have happened since we recorded it.
  const { models: statuses, exhaustedIds } = await computeModelStatus();
  const working: ModelDef[] = statuses
    .filter((s) => s.enabled && s.available)
    .map((s) => modelById(s.id)!)
    .filter(Boolean);
  // Fallback respects the user's untick: never reach for a disabled model just
  // because the enabled ones are momentarily exhausted/unconfigured.
  const enabledOrder = statuses.filter((s) => s.enabled).map((s) => modelById(s.id)!).filter(Boolean);
  const order = working.length
    ? working
    : enabledOrder.length
    ? enabledOrder
    : statuses.map((s) => modelById(s.id)!).filter(Boolean);
  const seed = new Set(exhaustedIds);
  const allSeeded = order.every((m) => seed.has(m.id));
  const exhausted = allSeeded ? new Set<string>() : seed;

  const actions: AgentResult["actions"] = [];
  // Cache results of identical calls so a stuck model can't repeat a write
  // (e.g. creating the same event 6 times until it hits the step cap).
  const seen = new Map<string, unknown>();
  let usedModel = order[0]?.id ?? "";
  let lastLimits: RateLimits = {};
  // Sum token usage across every model call this request (tool loop + summary).
  const usage = { prompt: 0, completion: 0, total: 0 };
  const addUsage = (u?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null) => {
    if (!u) return;
    usage.prompt += u.prompt_tokens ?? 0;
    usage.completion += u.completion_tokens ?? 0;
    usage.total += u.total_tokens ?? 0;
  };
  const meta = () => ({
    model: usedModel,
    models: order.map((m) => m.id),
    exhausted: [...exhausted],
    usage,
    limits: lastLimits,
    routed,
    routing: routed
      ? { tools: tools.map((t: any) => t.function.name), multi, slim, trigger: triggerKeyword }
      : null,
  });

  // Deterministic bulk delete/complete (explicit target from routing) — run these
  // directly so "delete all events and tasks" can never widen to notes, and a
  // pure-bulk request skips the tool-selection LLM call.
  for (const c of presetCalls) {
    console.log(`[agent] preset -> ${c.name}(${JSON.stringify(c.args)})`);
    const result = await runTool(c.name, c.args);
    actions.push({ name: c.name, args: c.args, result });
  }

  // Page read/summarize (read_site): the result is longform page text, so phrase
  // a proper-length reply — NOT the 20-word spoken cap. Done here so it works for
  // the deterministic shortcut/URL preset path with no pass-1 tool-selection call.
  const readAct = actions.find(
    (a) => a.name === "read_site" && (a.result as any)?.content
  );
  if (readAct) {
    const r = readAct.result as { content: string; title: string; mode: string };
    const reply = await readPageReply(r, order, exhausted, addUsage, (m, l) => {
      usedModel = m;
      lastLimits = l;
    });
    return { reply, actions, ...meta() };
  }

  // A natural-language final reply the model produced AFTER chaining tools — set
  // by the tool-loop below so we can return it directly (no extra summary call).
  let finalReply: string | null = null;

  if (onlyPreset) {
    // Nothing left for the model to decide. If the tool results are directly
    // speakable (e.g. "Paused."), return now — ZERO LLM tokens for the whole
    // request. Otherwise fall through to the cheap summary pass below.
    const direct = directReply(actions);
    if (direct) return { reply: clampWords(direct, maxWords), actions, ...meta() };
  } else {
    // Multi-step tool loop: the model can call tools, SEE their results, and then
    // call more tools (or answer) — so a request needing several rounds ("find my
    // most urgent email and reply", or "what's on Friday, then add a task") runs to
    // completion instead of stopping after the first batch. Each round we run the
    // model's tool calls, feed the results back as tool messages, and loop until it
    // answers with no tool call (or we hit the round cap). The first round can also
    // be a plain answer (a clarifying question / chat), which returns immediately.
    // Dependent multi-round chaining (call a tool, SEE its result, then decide to
    // call a DIFFERENT tool) is only needed for "and" requests (multi) — the prompt
    // tells single-intent turns to emit all their tool calls in ONE turn. So for a
    // single-intent request we stop after the first tool batch and let the cheap
    // summary pass (Pass 2 below) phrase the reply, instead of paying for another
    // full round that re-ships the entire tool schema + snapshot just to say "done"
    // (which also re-loads cold on a rate-limit rotation, burning the per-minute
    // token budget). multi requests keep the full loop so a dependent follow-up runs.
    const MAX_TOOL_ROUNDS = 5;
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const p = await complete(messages, exhausted, tools, order);
      usedModel = p.model;
      lastLimits = p.limits;
      addUsage(p.usage);
      const msg = p.completion.choices[0].message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        // The model is done — keep its spoken reply (returned after the read_site
        // check below). On the very first round with no actions, that's just chat.
        finalReply = cleanReply(msg.content) || (actions.length ? null : "Done.");
        break;
      }

      // Record the assistant turn (with its tool calls) so the next round has the
      // full context of what it already decided.
      messages.push({
        role: "assistant",
        content: msg.content ?? "",
        tool_calls: msg.tool_calls,
      });

      // Run every tool call from this turn (sequentially, so an ordered batch like
      // fetch-then-list still works). Dedupe identical calls so a model that emits
      // the same write twice can't double-apply it — but still feed a result back
      // for each call id so the conversation stays well-formed.
      for (const call of msg.tool_calls) {
        let args: any = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          /* leave args empty on parse failure */
        }
        if (args === null || typeof args !== "object") args = {};

        const sig = `${call.function.name}:${JSON.stringify(args)}`;
        let result: unknown;
        if (seen.has(sig)) {
          result = seen.get(sig);
        } else {
          console.log(`[agent] tool -> ${call.function.name}(${JSON.stringify(args)})`);
          result = await runTool(call.function.name, args);
          seen.set(sig, result);
          actions.push({ name: call.function.name, args, result });
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 4000),
        });
      }

      // Smart cloud turns keep looping so the model can chain a dependent next
      // call after seeing a result; when the model has no more tool calls the
      // loop exits above with its spoken reply. A non-looping turn stops after the
      // first batch and lets the cheap summary pass phrase the reply.
      if (!multiRound) break;
    }
  }

  // The model may have called read_site itself (e.g. "summarize <url>" routed via
  // the local group) — give that the longform read-back too, not the 20-word cap.
  const modelRead = actions.find(
    (a) => a.name === "read_site" && (a.result as any)?.content
  );
  if (modelRead) {
    const r = modelRead.result as { content: string; title: string; mode: string };
    const reply = await readPageReply(r, order, exhausted, addUsage, (m, l) => {
      usedModel = m;
      lastLimits = l;
    });
    return { reply, actions, ...meta() };
  }

  // The model finished the tool loop with its own spoken answer (it already saw
  // every tool result) — use it directly and skip the extra summary call.
  if (finalReply) return { reply: clampWords(finalReply, maxWords), actions, ...meta() };

  // Pass 2 (cheap): phrase the spoken reply from a TINY prompt + the tool
  // results — instead of replaying the whole system prompt + tools just to get a
  // sentence. This is the big token saver: the heavy context is paid once.
  try {
    // Prefer NON-reasoning models for the spoken summary so we never get a
    // chain-of-thought dump; reasoning models are used only if nothing else is
    // left. Cap output short — it's one sentence.
    const summaryOrder = [...order].sort(
      (a, b) => (a.reasoning ? 1 : 0) - (b.reasoning ? 1 : 0)
    );
    const sum = await complete(
      [
        { role: "system", content: summarySys(maxWords) },
        {
          role: "user",
          content: `The user said: "${userText}".\n\nResults of what you did:\n${summarizeActions(actions)}`,
        },
      ],
      exhausted,
      [],
      summaryOrder,
      200
    );
    usedModel = sum.model;
    lastLimits = sum.limits;
    addUsage(sum.usage);
    const reply = cleanReply(sum.completion.choices[0].message.content);
    if (reply) return { reply: clampWords(reply, maxWords), actions, ...meta() };
  } catch {
    /* fall back to a tool message below */
  }
  return { reply: clampWords(fallbackReply(actions), maxWords), actions, ...meta() };
}
