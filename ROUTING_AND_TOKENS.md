# Routing & token map — every command

How each voice command is handled, and **why**. Two cost tiers:

- **PRESET (deterministic, no LLM tool-selection):** the tool + its args are known
  from the words alone, built in code by `simplePreset()` / `resolveBulk()` in
  `lib/abilities.ts`. These **skip pass‑1** (the expensive call that ships the tool
  JSON schema + domain rules + data snapshot, ~1.6k+ tokens).
  - If the result has a clean `message`/`error` (e.g. "Paused.") → spoken directly
    by `directReply()` → **0 LLM tokens** for the whole request.
  - If the result is list/data → only the **~200‑token summary pass** runs to phrase it.
- **PASS‑1 (LLM decides):** the model is given the tool(s) + rules (+ snapshot) and
  picks/fills the call, then the summary pass phrases the reply. Used when args need
  judgement we won't risk in code (relative dates, free‑text splitting, by‑name
  targeting, security).

Guiding principle: **a missed token is cheap, a wrong write is not.** Gates err
toward deferring to the LLM whenever extraction is ambiguous.

---

## All routing rules (summary)

The complete set of rules the router applies, in order. Details + tables follow.

1. **Noun selects the domain, verb picks the action** — scanned left‑to‑right; word
   order is flexible ("list events" = "events list"). Leftmost noun wins ties.
2. **Only built‑in keywords select a domain.** Keywords you add in the Abilities tab
   only pick the action once the noun is present (never select on their own).
3. **A noun with no verb** (multi‑action card) → clarify ("which action?").
   **No card word at all** → plain chat (no tools).
4. **Split on "and" only into clear commands.** A trailing segment with no card noun
   merges into the command before it, so a free‑text argument containing "and" stays
   whole ("play hall and oates"). A real second command splits off.
5. **Deterministic preset (no pass‑1) when the tool + args are knowable from the
   words:** playback/queue/control, open app, open website, web search, all plain
   lists, contacts list/sync, email fetch/mark‑all, **delete/complete/reopen by ref
   number**, **task priority** (fixed enum), and all **bulk** ("all"/"wipe") actions.
6. **Pass‑1 (AI) when judgement is needed:** creating/editing **content**
   (titles/bodies), **relative dates** → ISO+TZ, **by‑name** targeting (no ref
   number), **filtered** reads, messaging, contacts add, and `run_shell`.
7. **Refs vs. names:** "delete task **3**" → preset; "delete task **call mom**"
   (no number) → pass‑1. Applies inside "and" per‑clause.
8. **Every clause of an "and" request is scanned** for a preset independently — a
   request can be part preset + part AI ("…and reprioritize task 3 to high").
9. **Bulk needs an explicit card** ("delete all **tasks**") — never inferred; a bare
   "delete everything" with no card does nothing.
10. **Open priority.** (a) A **website shortcut** wins (highest); (b) an **explicit
    type** — "open X **app** / **folder** / **website** / **shortcut**" — opens that
    respective kind; (c) **default** "open X" → shortcut if one exists, else the
    bridge chain **app → folder → website**. All deterministic (no AI).

---

## Word order is flexible

Routing is **not** "verb then noun". The **noun selects the domain wherever it
appears**, and the **earliest verb keyword picks the action**. So these are all
equivalent:

| You say | Routes to |
|---|---|
| `list events` / `events list` / `event list` | `list_events` |
| `delete task 3` / `task 3 delete` | `delete_task` |
| `done task 3` / `task 3 done` | `update_task` (done) |

Caveats: when **multiple** nouns appear, the **leftmost** selecting word wins
(`"create an event as a note"` → event). A noun with **no verb** in a multi‑action
card → Jarvis asks which action (clarify), regardless of order.

Only **built‑in default** keywords select a domain. Keywords **you** add in the
Abilities tab only pick the action once the noun is present — they never select on
their own. Each card lists its selectors under **"Say on its own"**.

---

## Splitting on "and" — only into clear commands

A request is split on "and" **only where the next segment is itself a clear command**
(it names a card). A segment with no card noun is treated as free‑text and **merged
into the command before it** — so an argument that contains "and" stays whole.

| You say | Result |
|---|---|
| `play hall and oates` | one `play_spotify` ("hall and oates") — "oates" isn't a command |
| `note buy milk and eggs` | one note body "buy milk and eggs" |
| `message mom I'll be late and bring food` | one message, body kept whole |
| `add note hi and reprioritize task 3 to high` | note (AI) **+** priority (preset) — "reprioritize task 3" **is** a command |
| `search ramen and play jazz` | `search_web` "ramen" **+** `play_spotify` "jazz" — both are commands |
| `delete task 3 and create note hi and bye` | delete preset **+** note "hi and bye" |

Rule of thumb: the tail splits off only when it clearly starts a new card action;
otherwise it's part of the current command's text.

## Update / delete: ref vs. name

- **Has a ref number** ("delete task 3", "reprioritize task 3 to high") → deterministic
  preset, no AI.
- **No number — targeted by name** ("delete task call mom", "rename the groceries task")
  → pass‑1, because the AI needs the data snapshot to find the right item.

This holds inside "and" too: every clause is scanned for a ref/number.

---

## PRESET — deterministic (no pass‑1)

| Command | Tool | Why it's safe in code |
|---|---|---|
| pause / resume / skip / next / previous / save / now playing | `spotify_control` | No‑param actions fully known from the keyword. Speaks directly (0 tokens). |
| play X / play some \<artist> / play album/playlist X | `play_spotify` | Query = rest of sentence; type from "some/album/playlist/artist". |
| queue X | `queue_spotify` | Query = rest of sentence. |
| open X (no type) | shortcut → `open_app` | **Priority:** a matching website shortcut wins; else `open_app`, whose bridge tries **app → folder → website** in code (the tool always sends a site fallback), so "open apple" → apple.com if no app/folder. No AI. |
| open X **app** | `open_app` (`only:"app"`) | Forces the app only — no folder/website fallback (reports if not installed). |
| open X **folder** | `open_app` (`only:"folder"`) | Forces a folder match only. |
| open X **website** / site / browser | `open_url` | Resolves the bare site in code. |
| open X **shortcut** | `open_url` (shortcut URL) | Forces the saved shortcut even with the word "shortcut". |
| search/google/lookup X | `search_web` | Query = rest. Bare "weather"/"news" defer (need phrasing). |
| **set/change task N priority to low\|medium\|high** | `update_task` | Priority is a fixed enum — `matchPriority()` reads the level + ref. The only content‑edit that's deterministic. Works inside "and" too. |
| list/show my tasks | `list_tasks` | Plain open‑task list; "all/completed/history" defer. |
| find/search notes X · list notes | `search_notes` | Query = rest, or empty for all. |
| list events / what's on my calendar | `list_events` | Wide now‑1d…+60d range built in code; **any date word defers** (needs a precise TZ range). |
| list/show projects | `list_projects` | All projects; reading **one** by name/ref defers. |
| list/show contacts | `list_contacts` | List all; delete‑by‑name defers. |
| sync/import \<google\|telegram> contacts | `sync_contacts` | Source from the words, else "all". |
| fetch/check/new/recent email | `fetch_emails_now` | No args. Speaks directly when 0 new. |
| mark **all** emails reviewed | `mark_emails_reviewed` | `all=true`; per‑sender defers (needs a query). |
| delete task/event/note/project **N** | `delete_*` | Ref is explicit; kind‑checked. No date/name ambiguity. |
| done/complete/undo/reopen task/event/project **N** | `update_*` | Ref + done flag from the verb; **defers on any field change** ("…as high priority"). |
| email **digest/summary/today** | `fetch_emails_now` + `list_emails(today_only)` | Run as a fixed 2‑step in `runAgent` (`isEmailDigest`) — guaranteed, skips pass‑1. |
| delete all / wipe \<card> · complete all \<card> | `delete_all` / `complete_all` | `resolveBulk()` sets an explicit target from the card — the LLM can never widen "all events" to "everything". |
| a user **website shortcut** ("deployment", "open deployment") | `open_url` | `matchShortcut()` maps the keyword → the saved URL (Abilities tab → Website shortcuts, stored in mail_kv). Exact‑match, optionally led by "open"/"go to". Checked before everything else. |

---

## PASS‑1 — the LLM decides (and why)

| Command | Tool | Why it needs the LLM |
|---|---|---|
| add/create task, note, project (any) | `create_task` / `create_note` / `create_project` | **AI extracts the content** (title/body) so trigger words, articles and phrasing come out clean. (Your call — see CHANGELOG 2026‑06‑08.) Tasks also need relative‑date→ISO+TZ resolution. |
| schedule/add event … | `create_event` | Content extraction **+** a time → relative‑date→ISO+TZ resolution. |
| rename / reschedule / edit body of task, event, note, project | `update_*` / `update_note` | Free‑text content edit (and/or date). The one exception is **task priority**, which is deterministic (see preset table). |
| update/change a note's text | `update_note` | Splitting "which note" from "the new body" is free‑text; risk of clobbering the wrong note. |
| add/edit/remove a project **improvement**, rename, project **time** | `update_project`, `project_time` | Multi‑field args (numbered improvement edits) and/or date resolution. |
| delete/complete something **by name** (no ref number) | `delete_*` / `update_*` | Needs the snapshot to map a name → the right item; by‑name is where wrong‑target writes happen. |
| email from \<sender> · urgent · latest stored | `list_emails` | Query extraction + filter logic (`min_urgency`, `limit`, `order`) is judgement, not a fixed shape. |
| mark \<sender>'s emails reviewed | `mark_emails_reviewed` | Needs a `query` parsed from free text. |
| message/text/DM someone … | `send_message` | Parse recipient + channel + body from natural language; outward‑facing, must be right. |
| add contact … | `add_contact` | Parse name + phone/telegram/email out of free text. |
| run \<command> | `run_shell` | Security‑sensitive command construction; must be modelled and is confirmed on device. |
| anything with no recognized keyword | — (chat) | No tools sent at all; plain conversational reply. |

---

## Gaps I left open on purpose

These *could* be made deterministic but aren't, for the reason given. Tell me if
you want any flipped:

- **`list_tasks` / `list_emails` with filters** ("completed tasks", "urgent
  emails") — the filter args are small but varied; deferring keeps the gates simple
  and costs only one pass‑1.
- **`add_contact`** — free‑text field parsing is messy; not worth a brittle regex.
- **Multi‑part ("and") requests** — each *clause* is scanned for a deterministic
  preset (ref delete/complete, priority, lists, spotify/open/search); only content
  creates/edits in a clause go to pass‑1. Splitting follows the "clear command"
  rule above (free‑text tails merge). The remaining limit: when several content
  creates are chained ("add note X and add task Y"), both go to pass‑1 together —
  the AI handles the batch.

---

## Performance: model warm‑up (first‑request latency)

The first command of a session used to feel slow — the serverless function was
cold and the provider's prompt cache was empty. Now the JARVIS page fires a
**warm‑up ping** (`POST /api/voice {warm:true}` → `warmModels()` in `lib/agent.ts`):

- **On page load** — wakes the function and sends 1‑token completions priming the
  provider's automatic prompt cache:
  - `CORE_PROMPT` (task/event/note/project prefix) → the **top two** non‑exhausted
    models, so a daily‑limit rotation still lands on a warm model.
  - `SLIM_CORE` (pure‑domain prefix: play/open/search/email/message) → the **active
    model only** — it's the shorter prefix, so warming it on two models is overkill.
- **On model rotation** — when a reply comes back from a different model (e.g. the
  previous one hit its daily limit), the client re‑warms, so the newly‑active model
  **and its next fallback** are primed for the following request.

It's fire‑and‑forget (failures are swallowed — worst case is a cold first request)
and warming the top two means a rotation still lands on a warm model.

---

## Where this lives in code

- `lib/abilities.ts` — `resolveRequest()` (routing), `simplePreset()` (arg
  extraction), `resolveBulk()` (bulk), `DATE_RE` (the date‑defer guard).
- `lib/agent.ts` — `runAgent()` (preset vs pass‑1 vs summary), `directReply()`
  (0‑token speak), `isEmailDigest` (fixed 2‑step digest), the snapshot toggle,
  `warmModels()` (first‑request warm‑up).
- `app/api/voice/route.ts` — `{warm:true}` ping; `components/VoiceButton.tsx` calls
  it on mount and after a model rotation.
- `lib/abilities.ts` — `matchShortcut()` (website shortcuts → open_url preset).
- `lib/shortcuts.ts` + `app/api/shortcuts/route.ts` — store/serve user website shortcuts.
- `components/Abilities.tsx` — the keyword editor + "Say on its own" + Website shortcuts + request box.
- `app/api/keyword-requests/route.ts` — saves Abilities‑tab requests to
  `keyword-requests.md`.
