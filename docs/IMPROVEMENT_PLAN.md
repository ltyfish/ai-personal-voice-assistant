# JARVIS Improvement Plan (Master Roadmap)

Last updated: 2026-07-11.
Audience: coding agents (including weaker models) executing tasks one at a time.

## How to use this document (READ FIRST)

- Pick ONE task. Do not start a task marked **[HARD]** unless explicitly assigned.
- Every task lists: files to touch, what to do, what NOT to do, and acceptance criteria.
- Before coding: read `CLAUDE.md`, then only the files the task names. Do not scan the repo.
- After coding: run `npx tsc --noEmit` (always) plus the task's listed checks. Never claim
  something is live-tested unless you actually ran it.
- Make the smallest safe change. Do not refactor neighboring code "while you're there".
- Update vault memory per `CLAUDE.md` (CHANGELOG always when code changed; TODO/BUGS/HANDOFF
  only when state changed). Commit and push when done.

## System summary (context for every task)

Next.js 14 App Router + TypeScript on Vercel; Neon Postgres via Drizzle (`db/schema.ts`).
Voice pipeline: mic capture in `components/VoiceButton.tsx` → `/api/transcribe` (Groq Whisper)
→ `/api/voice` → `lib/agent.ts` (tool loop over `lib/tools.ts`) → text reply → TTS in browser.
Multi-provider LLM routing: `lib/llm-router.ts` (rotating `/api/v1` proxy, key rotation + model
cooldowns + `llm_usage` tallies), chain config in `lib/models.ts` / `lib/model-config.ts`.
Local path: when the localhost bridge (`scripts/bridge/server.mjs`) is online, turns run a
client-driven tool loop (`lib/local-agent.ts`) with browser automation (`scripts/bridge/browser.mjs`,
Playwright). Phone→cloud→laptop relay via `lib/relay-store.ts` + `app/api/bridge/*`.
Desktop: Electron pet in `desktop/` calling the cloud `/api/voice`; auto-updates from GitHub Releases.
Extras: MailMind (`lib/mail/*`), Pipeline coding workflow (`lib/pipeline*.ts`), GitHub/Health tabs,
Spotify, messaging (WhatsApp/Telegram/email).

Known weak points driving this plan:
- No automated test suite; several existing check scripts are stale and fail on clean HEAD.
- `/api/voice` is non-streaming, so TTS waits for the full completion (biggest felt latency).
- Very large files (`VoiceButton.tsx` 2360 lines, `tools.ts` 2264, `agent.ts` 1584, `app/page.tsx` huge)
  make every change risky.
- Duplicate usage accounting, undocumented `mail_kv` namespaces, in-memory state that resets per
  serverless instance, and many features that are built but never live-tested.

---

## Phase 0 — Stabilize the ground (do these before anything else)

### 0.1 Fix or retire the stale regression checks
- Files: `scripts/check-browser-automation-flow.mjs`, `scripts/check-tool-toggle-wiring.mjs`,
  `scripts/check-router-catalog-rotation.mjs`, `scripts/check-router-chain-alignment.mjs`.
- Problem: all four FAIL on unmodified HEAD (they assert prompts/gates/chain contents that were
  reworked). A failing baseline trains everyone to ignore checks.
- Do: for each script, read what it asserts, compare to current code, and either update the
  assertion to today's truth or delete the script (delete only if the behavior it guarded no
  longer exists). Prefer updating.
- Acceptance: all remaining `scripts/check-*.mjs` pass on clean HEAD. Record the final list in
  the new `scripts/check-all.mjs` from task 0.2.

### 0.2 One command that runs every check
- New file: `scripts/check-all.mjs`; add `"check": "node scripts/check-all.mjs"` to `package.json`.
- Do: run `npx tsc --noEmit`, then each passing `scripts/check-*.mjs`, then
  `node --check scripts/bridge/server.mjs` and `node --check scripts/bridge/browser.mjs`.
  Print PASS/FAIL per step, exit non-zero on any failure.
- Acceptance: `npm run check` passes on clean HEAD; a deliberately introduced type error makes it fail.

### 0.3 CI on every push
- File: new `.github/workflows/ci.yml` (the desktop release workflow already exists; don't touch it).
- Do: on push/PR to `main`, run `npm ci`, `npm run check`, `npm run build`.
- Acceptance: workflow green on `main`.

### 0.4 Real unit tests (start tiny)
- Do: add `vitest` as a devDependency (this is an explicitly approved dependency addition).
  Create `tests/` with first targets — pure functions with no I/O:
  - `lib/recur.ts` (recurrence expansion: weekly, monthly, edge dates)
  - `lib/refs.ts` (entity reference resolution)
  - `lib/llm-router.ts` key-rotation/cooldown decision logic (extract the pure decision function
    if needed — smallest possible extraction, no behavior change)
  - `lib/memory.ts` `renderMemoryMarkdown()` + the memory.md parser (round-trip test)
- Wire `vitest run` into `scripts/check-all.mjs` and CI.
- Acceptance: `npx vitest run` green; at least 15 meaningful assertions.

---

## Phase 1 — Latency & speed (highest user-felt impact)

### 1.1 Stream the spoken reply (SSE) — THE big win [HARD]
- Files: `app/api/voice/route.ts`, `lib/agent.ts` (it already has `createCompletionStream` +
  `pumpSentences`), `components/VoiceButton.tsx`, desktop consumer in `desktop/src/` (voice turn IPC).
- Do: make `/api/voice` emit an SSE/chunked stream of sentence-sized text segments for the FINAL
  reply only (tool-calling rounds stay non-streamed). VoiceButton starts TTS on the first sentence
  and queues subsequent ones. Keep a non-streaming fallback: if the client doesn't send
  `accept: text/event-stream`, return the current JSON shape unchanged (desktop + relay keep working
  until they're migrated).
- Do NOT: change tool-call semantics, the gate, or pending-action confirm flow.
- Acceptance: web voice turn speaks noticeably before the full reply is done; non-streaming clients
  (curl the route with plain JSON) still get the old response shape; `npm run check` passes.
- Split into two commits: (a) server SSE + fallback, (b) VoiceButton consumption. Desktop migration
  is a separate later task (1.4).

### 1.2 Parallelize `/api/voice` startup reads
- File: `lib/agent.ts` (`prepareTurn` / systemPrompt build) and `app/api/voice/route.ts`.
- Do: audit every awaited Neon/mail_kv read on the turn path; anything independent goes into one
  `Promise.all` (some of this was done 2026-06-19 — verify and finish). Add a `console.log("[timing] …")`
  per stage (prep, model rounds, tools, total) guarded by `process.env.VOICE_TIMING === "1"`.
- Acceptance: no serial awaits that could be parallel; timing logs appear only with the env flag.

### 1.3 Model-latency-aware ranking
- Files: `lib/model-rank.ts`, `lib/llm-router.ts`, `db` table `llm_usage` (already tallied per success).
- Do: record per-call duration in the router event/usage write (column or router_events payload —
  prefer whichever already has a JSON payload to avoid a migration). Compute rolling p50 per model
  (last N events) and use it as a tiebreaker in `autoChainOrder()` after the existing
  health/failure demotion. Never let latency ranking override the enabled/cooldown filters.
- Acceptance: unit test for the ranking comparator; router feed still renders.

### 1.4 Desktop turn latency pass
- Files: `desktop/src/main/*` (voice turn path), `desktop/src/shared/voice-capture.ts`.
- Do: (a) reuse a keep-alive HTTP agent / warm connection to the cloud for `/api/voice` and
  `/api/transcribe`; (b) start the transcribe upload as soon as capture ends (no extra IPC hops);
  (c) after 1.1 ships, consume the SSE stream and start TTS on first sentence; (d) add spoken/visual
  "thinking" feedback if agent stage exceeds ~2.5s.
- Acceptance: `%APPDATA%\jarvis-desktop\desktop.log` stage timings show reduced agent-stage wait;
  `node scripts/check-desktop-electron.mjs` + desktop typecheck/build pass.

### 1.5 Trim the system prompt / context per turn
- Files: `lib/agent.ts` (systemPrompt), `app/api/agent/prep/route.ts`, `lib/ollama-context.ts`.
- Do: measure the token size of a typical cloud turn's system prompt (log length under the
  VOICE_TIMING flag). Move rarely-needed instructions behind conditionals (e.g., browser guidance
  only when browser tools are enabled; Spotify rules only when Spotify is configured). Filter the
  tool schema to plausibly-relevant groups on CLOUD turns too (local already filters via
  `getEnabledLocalToolNames`), but keep a conservative always-on core (tasks/calendar/notes/projects).
- Do NOT: remove the "# About me" block or activity recall.
- Acceptance: measured prompt tokens drop; a data turn, a Spotify turn, and a browser turn still work
  (describe which you could actually test).

---

## Phase 2 — Reliability & production-grade behavior

### 2.1 Live-verify the 2026-07-11 router key-rotation fix
- This is a TEST task, not a code task. Watch ModelHud LIVE ROTATION during real turns; a single-key
  429 must rotate keys and stay on the same model (e.g. gpt-oss-120b), not bench it for 30 min.
- If it fails, debug `routeOne` in `lib/llm-router.ts`; the intended semantics are documented in
  HANDOFF.md (vault) 2026-07-11.

### 2.2 Persist router state across serverless instances [HARD]
- Files: `lib/llm-router.ts`, `lib/router-feed.ts`, `lib/model-hud.ts`.
- Problem: cooldowns, LRU key rotation position, and the router feed live in module memory; every
  Vercel cold start / parallel instance has its own view, so cooldowns don't actually protect keys
  and the feed misses events from other instances.
- Do: move model cooldowns + per-key cooldowns to `mail_kv` (namespaces already exist:
  `router_model_cooldown`, `router`) with short TTL semantics and an in-memory read-through cache
  (refresh at most every ~5s to avoid a Neon read per pick). Feed can stay best-effort in-memory —
  document that limitation in a comment instead of "fixing" it.
- Acceptance: two consecutive requests to a fresh deployment respect a cooldown set by a prior
  instance (verifiable locally by clearing module state between calls in a unit test).

### 2.3 Single source of truth for usage accounting
- Files: `lib/llm-router.ts` (`llm_usage` writes), `lib/groq.ts` (`addGroqUsage` / mail_kv `groq-stats`).
- Do: make `llm_usage` the only tally. Find every reader of groq-stats (`grep addGroqUsage\|groq-stats`),
  point them at `/api/llm-keys/usage` aggregates, then delete the groq-stats write path and its
  namespace docs entry (task 2.4 documents namespaces).
- Acceptance: token counts still render everywhere they did; no remaining references to groq-stats.

### 2.4 Audit + document `mail_kv` namespaces
- Files: new `docs/data-model.md`; code references under `lib/`.
- Do: grep for every mail_kv namespace string (`memory, github, health, bridge_relay, router,
  router_model_cooldown, pagecache, digest-state, groq-stats, …`). For each: what writes, what reads,
  growth behavior, pruning. Delete confirmed-dead namespaces' write/read code (each deletion its own
  commit). Add pruning for anything unbounded (`pagecache` is the prime suspect — cap rows or add TTL).
- Acceptance: `docs/data-model.md` lists every live namespace + every Drizzle table with one-line
  purpose; no unbounded-growth namespace remains.

### 2.5 Timeouts, retries, and error taxonomy on every external call
- Files: `lib/spotify.ts`, `lib/github.ts`, `lib/messaging.ts`, `lib/telegram-user.ts`,
  `lib/google-contacts.ts`, `lib/mail/*`, `lib/webread.ts`.
- Do: sweep for `fetch(` without `AbortSignal.timeout(...)`. Standard: 15s default, 60s for
  LLM/transcribe. One retry with jitter for idempotent GETs only. Errors returned to the agent loop
  must be short, actionable strings ("Spotify token expired — reconnect in Settings"), never raw
  stack traces (the model reads these).
- Acceptance: no timeout-less external fetch on the turn path; tsc clean.

### 2.6 Health endpoint → real production monitoring
- Files: `lib/health.ts`, `app/api/health/route.ts`.
- Do: extend `/api/health` to report per-subsystem status: db round-trip ms, count of enabled models
  with ≥1 un-cooled key, Gmail token validity (needsReconnect boolean, reuse `/api/mail/check-accounts`
  logic), bridge relay presence age. Keep the response fast (<1s) — parallel checks with individual
  timeouts, degrade to `"unknown"`.
- Then (user action, document in README): point an external uptime monitor (UptimeRobot/cron) at it,
  and optionally have the mail cron send a Telegram alert when a subsystem is red twice in a row.
- Acceptance: `GET /api/health` returns the richer shape with `ok` preserved for existing monitors.

### 2.7 MailMind resilience (Gmail OAuth is the known failure)
- Files: `lib/mail/auth.ts`, `lib/mail/fetch.ts`, cron functions.
- Do: when refresh returns `invalid_grant`, (a) persist a `needsReconnect` flag, (b) send ONE
  Telegram notification ("Gmail disconnected — open Settings to reconnect", de-dupe via digest-state
  style marker), (c) make cron runs cheap no-ops until reconnected instead of failing loudly every
  10 minutes.
- Acceptance: simulated invalid_grant path sends at most one notification and subsequent fetches
  short-circuit.

### 2.8 Relay hardening
- Files: `lib/relay-store.ts`, `app/api/bridge/*`, `scripts/bridge/server.mjs`.
- Do: add timestamp+nonce to enqueued commands and reject commands older than 60s; add a per-minute
  enqueue rate cap; log (never expose) auth failures. Confirm the shared-secret comparison is
  constant-time (`crypto.timingSafeEqual`).
- Acceptance: replayed old command is rejected; normal round-trip unaffected.

---

## Phase 3 — Accuracy & making the assistant smarter

### 3.1 Turn-quality eval harness [HARD]
- New: `scripts/eval/` with ~30 canned utterances covering: task CRUD (+dates/recurrence), calendar,
  notes, projects+improvements, "what's on my plate today", Spotify, messaging drafts, ambiguous
  references ("move that to Friday"), and refusal cases (should ask, not act).
- Do: each case = utterance + expected tool calls (name + key args) or expected reply property.
  Runner hits `/api/voice` (or `planTurn` directly with a mocked tool executor — prefer this: no
  side effects) and scores tool-call match. Output a table: case, pass/fail, model used.
- Why: today "accuracy" changes are vibes. This makes prompt/model/chain edits measurable.
- Acceptance: `node scripts/eval/run.mjs` prints a scoreboard; document baseline score in the
  script header. Every future prompt change must state before/after eval numbers.

### 3.2 Better short-term memory injection
- Files: `lib/agent.ts` (activity recall), `app/api/agent/prep/route.ts`.
- Do: recall currently injects recent activity rows. Improve selection: last 5 turns PLUS any turn
  in the last hour that mentions an entity named in the current utterance (simple keyword match on
  the activity text — no embeddings needed yet). Cap total injected recall to ~1200 chars.
- Acceptance: eval cases with follow-up references ("mark it done") pass at least as often as before.

### 3.3 Date/time correctness sweep
- Files: `lib/agent.ts` system prompt date handling, `lib/recur.ts`, `lib/tools.ts` date parsing.
- Do: the user is in Singapore time (MailMind already assumes SGT). Ensure the system prompt states
  current date AND timezone, tools normalize relative dates ("tomorrow", "next fri") server-side in
  SGT, and unit-test the edge cases (month end, year rollover, "this weekend").
- Acceptance: recurrence + relative-date unit tests green; eval date cases pass.

### 3.4 Tool-result summarization for long payloads
- Files: `lib/agent.ts` tool-loop, `lib/tools.ts` list tools.
- Do: list tools (tasks/events/emails) can return large JSON that bloats context and confuses weak
  models. Cap tool results injected into the loop at ~2000 chars with "…and N more; call again with
  a filter" tail. Ensure list tools accept filters (done/undone, date range) so the model can narrow.
- Acceptance: "what are all my tasks" with 50+ tasks still answers correctly; context size per turn drops.

### 3.5 Confidence-gated confirmations
- Files: `lib/agent.ts`, `components/VoiceButton.tsx` pending-action flow.
- Do: destructive tools (delete_*, bulk ops, send_message, run_shell) already confirm. Verify the
  list is complete (grep tool names against the confirm allowlist) and add any missing (e.g.
  reorder/bulk done flags are fine unconfirmed; message sends and deletes are not).
- Acceptance: a table in `docs/data-model.md` (or code comment) of every tool → confirm yes/no.

---

## Phase 4 — Code cleanliness (do AFTER tests exist; each is its own PR)

Rules for all Phase 4 tasks: pure mechanical extraction, zero behavior change, tsc + checks + eval
must pass before and after, one extraction per commit.

### 4.1 Split `components/VoiceButton.tsx` (2360 lines) [HARD]
- Extract in this order (least entangled first):
  1. TTS/voice-picker logic → `lib/tts-client.ts` + `components/voice/VoicePicker.tsx`
  2. Bridge/relay settings panel → `components/voice/BridgeSettings.tsx`
  3. LOCAL AI tool-group deck panel → `components/voice/LocalToolsPanel.tsx`
  4. Recording/wake orchestration hooks → `hooks/useVoiceCapture.ts`
- Keep `VoiceButton.tsx` as the coordinator. Target <800 lines.

### 4.2 Split `lib/tools.ts` (2264 lines)
- Extract per domain: `lib/tools/tasks.ts`, `calendar.ts`, `notes.ts`, `projects.ts`, `spotify.ts`,
  `messaging.ts`, `github.ts`, `browser.ts`, with `lib/tools.ts` re-exporting `toolDefs`/`runTool`
  unchanged (import sites must not change).

### 4.3 Split `app/page.tsx` panels
- Extract `TasksPanel`, `CalendarPanel`, `NotesPanel`, `ProjectsPanel`/`ProjectCard` into
  `components/dashboard/`. Watch the cross-panel improvement-move logic (it lives at ProjectsPanel
  level deliberately — keep it there).

### 4.4 Split `lib/agent.ts` (1584 lines)
- Extract: system-prompt builder → `lib/agent/prompt.ts`; model-chain runner → `lib/agent/chain.ts`;
  page-read/plan helpers → `lib/agent/page.ts`. Keep exported API identical.

### 4.5 Dead code + config hygiene
- Do: remove `lib/local-mode.ts` if truly a no-op shim (verify importers first); delete unused deps
  (`@remotion/player`, `remotion`, `mammoth`, `pdf-parse`, `cloudinary`, `twilio` — VERIFY each with
  grep before removing; if used, leave it and note where). Resolve the duplicated
  `tailwind.config.js` vs `tailwind.config.ts` (keep the one Next actually loads). Fix the merge
  conflict markers in `CLAUDE.md` (`<<<<<<< HEAD` block is committed!).
- Acceptance: `npm run build` passes; bundle/`node_modules` shrink noted in commit message.

### 4.6 Shared fetch/JSON helpers
- Do: create `lib/http.ts` with `fetchJson(url, {timeoutMs, retries})` implementing task 2.5's
  standard; migrate call sites gradually (each migration bundled with the 2.5 sweep, not separately).

---

## Phase 5 — User experience

### 5.1 Perceived-latency UX
- Immediate "heard you" cue: play a soft chime + show the transcript the moment STT returns, before
  the agent reply (web `VoiceButton` + desktop pet Thinking stage). After 1.1, first-sentence TTS
  covers the rest.

### 5.2 Error voice lines
- When a turn fails (model chain exhausted, network, tool crash), speak a short friendly line
  ("Hit a snag with the model — try again?") instead of silence. Files: `VoiceButton.tsx` error
  paths, desktop renderer.

### 5.3 Mobile pass
- LLM Keys got a mobile fix; do the same sweep for the dashboard (`app/page.tsx` panels), Abilities,
  GitHub tab, and ModelHud at 390px. Use Playwright screenshot checks like
  `scripts/check-llm-keys-mobile.mjs` as the pattern.

### 5.4 Onboarding / empty states
- First-run: empty tasks/calendar/notes should show one-line hints ("Say: add a task to …").
  Bridge/relay settings need inline explanations of what each secret does and a "test connection"
  button (relay presence check already exists — surface it).

### 5.5 Activity & transparency
- The Activity card exists; add a per-turn expandable detail (tools called + models used + duration)
  so failures are self-diagnosable without the vault. Data already flows through activity/router feed.

### 5.6 PWA basics
- Add manifest + icons so the phone can install the site; cache static shell only (no offline data
  promises). Low effort, high phone-UX value.

---

## Phase 6 — New features (only after Phases 0–2 are done)

Ordered by value/effort:

1. **Proactive daily briefing** — cron (reuse Netlify/mail cron) at a configured SGT time composes
   "today: N events, top tasks, urgent email count, weather?" via the router and sends to Telegram +
   speaks on next site open. Reuses digest infra.
2. **Reminders that actually fire remotely** — `components/Reminders.tsx` is client-mounted; add a
   cron sweep that Telegrams due reminders so they fire when the site is closed.
3. **Semantic memory (embeddings) [HARD]** — embed activity log + notes into a pgvector table
   (Neon supports pgvector); recall top-k relevant snippets per turn instead of keyword match (3.2
   is the stepping stone). Only after eval (3.1) exists to prove it helps.
4. **Calendar ingestion** — read-only Google Calendar sync into `events` (googleapis already a dep,
   OAuth pattern exists in mail). Massive daily-use value.
5. **Voice interruption (barge-in)** — stop TTS when the wake word / new speech is detected mid-reply.
   Wake infra exists (`lib/wakeword.ts`).
6. **Multi-turn conversation mode on desktop** — keep a rolling window of the last N turns for the
   pet like the web live-loop does.
7. **Model auto-benchmarking** — nightly cron runs 3 eval cases against each enabled model, feeds
   pass-rate into `autoChainOrder()` ranking (extends 1.3/3.1).

## Suggested sequencing

1. Phase 0 entirely (0.1 → 0.4). Nothing else is safe to verify without it.
2. 2.1 (live test), 1.1 streaming, 1.2, 2.5 — the user feels these immediately.
3. 2.2–2.4, 2.6–2.8 — production-grade backbone.
4. 3.1 eval harness, then 3.2–3.5 guided by eval scores.
5. Phase 4 splits interleaved as capacity allows (tests must exist first).
6. Phase 5 UX, then Phase 6 features.

## Standing conventions for agents working this plan

- Never expose or log secrets/tokens/`.env` values. Errors surfaced to the model/user must be sanitized.
- Any DB change = a migration script in `scripts/` (pattern: `scripts/create-*-table.mjs`) + note in
  vault CHANGELOG; never assume `db:push` was run.
- Anything touching the bridge requires a bridge restart to test — say so in your handoff.
- "Done" means: tsc clean, `npm run check` green, task's acceptance criteria met, honest note about
  what was NOT live-tested, vault memory updated, committed and pushed.
