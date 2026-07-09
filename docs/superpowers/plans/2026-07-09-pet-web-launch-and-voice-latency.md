# Pet Web Launch and Voice Latency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a visible website-launch button to the desktop pet and reduce voice latency by ending capture after speech followed by silence and selecting fast desktop transcription.

**Architecture:** Keep browser launch inside Electron's existing IPC boundary. Put silence-stop decisions and STT model selection in pure modules with Node tests, while browser-specific audio analysis remains a small renderer adapter. Return optional stage timings from the voice API and log them in Electron without recording voice contents.

**Tech Stack:** Electron 33, React 18, TypeScript, Vite, Next.js 14 route handlers, Groq SDK, Node test runner.

---

### Task 1: Silence-stop decision

**Files:**
- Create: `desktop/src/shared/voice-capture.ts`
- Create: `desktop/test/voice-capture.test.mjs`
- Modify: `desktop/package.json`

- [ ] **Step 1: Write the failing pure-state tests**

Create tests that import `shouldStopForSilence` from the compiled shared module and assert:

```js
assert.equal(shouldStopForSilence({ elapsedMs: 500, speechObserved: true, silentForMs: 900 }), false);
assert.equal(shouldStopForSilence({ elapsedMs: 1200, speechObserved: false, silentForMs: 900 }), false);
assert.equal(shouldStopForSilence({ elapsedMs: 1200, speechObserved: true, silentForMs: 799 }), false);
assert.equal(shouldStopForSilence({ elapsedMs: 1200, speechObserved: true, silentForMs: 800 }), true);
assert.equal(shouldStopForSilence({ elapsedMs: 5200, speechObserved: false, silentForMs: 0 }), true);
```

Add `test:voice-capture` to build the main TypeScript project and run this test.

- [ ] **Step 2: Run the test and verify RED**

Run: `npm --prefix desktop run test:voice-capture`

Expected: FAIL because `dist/shared/voice-capture.js` does not exist.

- [ ] **Step 3: Implement the decision function**

Export constants for `MIN_CAPTURE_MS = 700`, `SILENCE_STOP_MS = 800`, and `MAX_CAPTURE_MS = 5200`. Implement `shouldStopForSilence` so the hard maximum wins, otherwise stopping requires minimum duration, observed speech, and sustained silence.

- [ ] **Step 4: Run the focused and existing desktop tests**

Run: `npm --prefix desktop run test:voice-capture`

Expected: PASS.

Run: `npm --prefix desktop test`

Expected: all desktop tests PASS.

- [ ] **Step 5: Commit**

Commit `desktop/src/shared/voice-capture.ts`, `desktop/test/voice-capture.test.mjs`, and `desktop/package.json`.

### Task 2: Renderer silence detection

**Files:**
- Modify: `desktop/src/renderer/App.tsx`

- [ ] **Step 1: Extend the failing wiring check**

Update `scripts/check-desktop-electron.mjs` to require imports and calls for `shouldStopForSilence`, `AudioContext`, and analyser cleanup.

- [ ] **Step 2: Run the wiring check and verify RED**

Run: `node scripts/check-desktop-electron.mjs`

Expected: FAIL because the renderer does not yet use silence detection.

- [ ] **Step 3: Add the analyser loop**

When recording starts, create an `AudioContext`, media-stream source, and analyser. Track whether amplitude crosses a speech threshold and the timestamp at which silence begins. Call `shouldStopForSilence` on animation frames and stop the recorder when it returns true. Always cancel the frame and close the audio context in recorder completion, errors, and component cleanup. Retain the hard timeout as a fallback.

- [ ] **Step 4: Verify renderer integration**

Run: `node scripts/check-desktop-electron.mjs`

Expected: PASS.

Run: `npm --prefix desktop run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit the renderer and wiring-check changes.

### Task 3: Desktop fast-STT selection

**Files:**
- Create: `lib/stt-model.ts`
- Create: `scripts/check-stt-model-selection.mjs`
- Modify: `lib/groq.ts`
- Modify: `app/api/voice/route.ts`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/shared/types.ts`

- [ ] **Step 1: Write the failing selection check**

Create a Node check that loads the pure selector and asserts:

```js
assert.equal(selectSttModel("fast"), "whisper-large-v3-turbo");
assert.equal(selectSttModel("default"), "whisper-large-v3");
assert.equal(selectSttModel("unexpected"), "whisper-large-v3");
```

- [ ] **Step 2: Run the check and verify RED**

Run: `node scripts/check-stt-model-selection.mjs`

Expected: FAIL because `lib/stt-model.ts` and its compiled/loadable implementation do not exist.

- [ ] **Step 3: Implement selection and request wiring**

Define default and turbo model constants plus `selectSttModel`. Add `sttMode?: "default" | "fast"` to voice-turn diagnostics/input handling. Set multipart field `sttMode=fast` in Electron. Parse it in `/api/voice` and pass the selected model to `groq.audio.transcriptions.create`.

- [ ] **Step 4: Verify selection and TypeScript**

Run: `node scripts/check-stt-model-selection.mjs`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit selector, check, route, Groq constants, Electron request, and types.

### Task 4: Voice timing diagnostics

**Files:**
- Modify: `desktop/src/shared/types.ts`
- Modify: `desktop/src/main.ts`
- Modify: `app/api/voice/route.ts`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Add failing source assertions**

Require the route to return numeric `sttMs`, `agentMs`, and `totalMs`, and Electron to log request and returned stage durations without logging transcript/audio.

- [ ] **Step 2: Run the wiring check and verify RED**

Run: `node scripts/check-desktop-electron.mjs`

Expected: FAIL because timing fields are absent.

- [ ] **Step 3: Add timing measurements**

Use `performance.now()` around transcription and `runAgent`, include rounded values in optional `timings`, and record the Electron request duration around `postVoiceForm`. Add the optional timing object to `VoiceTurnResult`.

- [ ] **Step 4: Verify diagnostics**

Run: `node scripts/check-desktop-electron.mjs`

Expected: PASS.

Run: `npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit timing diagnostics and tests.

### Task 5: Visible Open JARVIS button

**Files:**
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `desktop/src/renderer/app.css`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/shared/types.ts`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Add the failing wiring assertions**

Require a visible button with text `Open JARVIS`, a renderer call to `openFullJarvis`, and a result shape that permits launch errors to reach the renderer.

- [ ] **Step 2: Run the wiring check and verify RED**

Run: `node scripts/check-desktop-electron.mjs`

Expected: FAIL because no visible button exists.

- [ ] **Step 3: Implement launch feedback**

Change the IPC handler/API to return `{ ok: true }` or `{ ok: false, error }`. Add `openJarvis` in the renderer, call it from the visible action button, and show a concise reply only on failure. Reuse the existing action-button styling.

- [ ] **Step 4: Verify launch integration**

Run: `node scripts/check-desktop-electron.mjs`

Expected: PASS.

Run: `npm --prefix desktop run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit the button, IPC result handling, types, styles if needed, and check updates.

### Task 6: Full verification and production delivery

**Files:**
- Modify only if verification exposes a tested defect.

- [ ] **Step 1: Run desktop verification**

Run: `npm --prefix desktop test`

Expected: all tests PASS.

Run: `npm --prefix desktop run typecheck`

Expected: PASS.

- [ ] **Step 2: Run web verification**

Run: `npm run build`

Expected: Next.js production build succeeds.

- [ ] **Step 3: Review intended diff**

Run: `git status --short`, `git diff --check`, and inspect the branch diff against `origin/main`. Exclude pre-existing deletion of `jarvis-pet.env.example`, generated `tsconfig.tsbuildinfo`, untracked `Images/`, and untracked root `main.js` unless they are independently required.

- [ ] **Step 4: Push to main**

Fetch origin, verify the branch can be integrated without overwriting newer remote work, merge or fast-forward the verified commits into `main`, and push `main`.

- [ ] **Step 5: Verify Vercel**

Inspect the production deployment associated with the pushed commit. Confirm status `READY`, the production URL, commit SHA, and absence of build errors. If Vercel Git integration is unavailable, use the linked project configuration and authenticated Vercel CLI to build/deploy production.
