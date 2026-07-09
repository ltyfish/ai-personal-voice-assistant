# Automatic Desktop Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a Windows JARVIS Pet release after every successful `main` build, expose the latest installer from JARVIS Web, and let installed pets download updates and restart only after user confirmation.

**Architecture:** GitHub Actions generates a monotonic `0.1.<run_number>` version and publishes Electron Builder's NSIS artifacts to GitHub Releases. The Electron main process owns `electron-updater`, converts its events into shared state, and exposes narrow IPC operations through preload. The website links directly to the stable latest-release installer endpoint.

**Tech Stack:** Electron 33, electron-updater, electron-builder, React 18, Next.js 14, GitHub Actions, GitHub Releases, Node test runner.

---

### Task 1: Pure updater state model

**Files:**
- Create: `desktop/src/shared/update-state.ts`
- Create: `desktop/test/update-state.test.mjs`
- Modify: `desktop/package.json`

- [ ] Write failing tests for mapping `checking-for-update`, `update-available`, `download-progress`, `update-downloaded`, `update-not-available`, and `error` events to renderer-safe states.
- [ ] Run `npm --prefix desktop run test:update-state` and verify it fails because the module is missing.
- [ ] Implement `DesktopUpdateStatus`, `initialUpdateStatus`, and `reduceUpdateEvent` without importing Electron.
- [ ] Run the focused test and full desktop suite; expect all tests to pass.
- [ ] Commit the state model and tests.

### Task 2: Main-process updater controller

**Files:**
- Create: `desktop/src/main/updater.ts`
- Modify: `desktop/src/main.ts`
- Modify: `desktop/src/shared/types.ts`
- Modify: `desktop/package.json`
- Modify: `desktop/package-lock.json`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] Add failing wiring assertions requiring packaged-only checks, `electron-updater`, safe state publication, manual retry, and quit-and-install IPC.
- [ ] Run `node scripts/check-desktop-electron.mjs` and verify the new assertions fail.
- [ ] Install `electron-updater` as a desktop runtime dependency.
- [ ] Implement a controller that disables auto-install-on-quit, checks shortly after packaged startup and every six hours, logs errors, and emits shared states.
- [ ] Register `desktop:getUpdateStatus`, `desktop:checkForUpdates`, and `desktop:installUpdate`; add **Check for updates** to the tray.
- [ ] Run the wiring check, desktop typecheck, and tests; expect success.
- [ ] Commit the updater controller and dependency changes.

### Task 3: Preload and renderer update UX

**Files:**
- Modify: `desktop/src/preload.cts`
- Modify: `desktop/src/shared/types.ts`
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `desktop/src/renderer/app.css`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] Add failing wiring assertions for update listeners, retry, and a **Restart and update** button rendered only for `ready`.
- [ ] Run the wiring check and verify it fails.
- [ ] Expose typed status/listener/check/install methods through preload.
- [ ] Subscribe in the renderer, show concise download progress or error text, add retry for errors, and show **Restart and update** only when ready.
- [ ] Run wiring checks and desktop typecheck; expect success.
- [ ] Commit the renderer update experience.

### Task 4: Electron Builder GitHub publishing

**Files:**
- Modify: `desktop/package.json`
- Create: `scripts/check-desktop-release-config.mjs`

- [ ] Write a failing source check that requires GitHub provider owner `ltyfish`, repository `ai-personal-voice-assistant`, NSIS target, updater metadata, and CI-controlled version input.
- [ ] Run the release-config check and verify it fails.
- [ ] Configure Electron Builder's GitHub publish provider and artifact naming while retaining NSIS/blockmap output.
- [ ] Add a CI script that writes the generated semantic version into a temporary desktop package copy before packaging.
- [ ] Run the release-config check and desktop packaging configuration validation.
- [ ] Commit publishing configuration.

### Task 5: Main-branch release workflow

**Files:**
- Create: `.github/workflows/release-desktop.yml`
- Modify: `scripts/check-desktop-release-config.mjs`

- [ ] Extend the failing source check to require `push.branches: [main]`, `contents: write`, Node setup, lockfile installs, desktop tests/typecheck, Electron wiring check, web build, generated `0.1.<run_number>` version, Windows packaging, and GitHub Release publishing.
- [ ] Run the release-config check and verify it fails.
- [ ] Implement the Windows workflow using pinned major action versions and `GITHUB_TOKEN`.
- [ ] Ensure publishing occurs only after every verification step succeeds.
- [ ] Run the release-config check; expect success.
- [ ] Commit the workflow.

### Task 6: Website installer entry point

**Files:**
- Create: `components/DesktopPetDownload.tsx`
- Modify: `app/page.tsx`
- Modify: `app/globals.css`
- Create: `scripts/check-desktop-download-ui.mjs`

- [ ] Write a failing source check requiring visible **Download JARVIS Pet for Windows** text and a direct GitHub latest-release installer URL.
- [ ] Run the check and verify it fails.
- [ ] Build a compact download control in the main JARVIS header/overflow area that explains the pet uses the cloud website and downloads from GitHub.
- [ ] Use the stable URL `https://github.com/ltyfish/ai-personal-voice-assistant/releases/latest/download/JARVIS-Desktop-Setup.exe`.
- [ ] Run the source check and Next production build; expect success.
- [ ] Commit the website download control.

### Task 7: Verification, main delivery, and first release

**Files:**
- Modify only when a verification failure has a tested root cause.

- [ ] Run desktop tests, desktop typecheck, Electron wiring check, release configuration check, download UI check, and `npm run build`.
- [ ] Inspect `git diff --check`, status, and branch commits while excluding unrelated local files.
- [ ] Fetch `origin/main`, confirm fast-forward safety, and push the verified branch to `main`.
- [ ] Monitor the `release-desktop` GitHub Actions run to completion and inspect failing logs if necessary.
- [ ] Confirm a GitHub Release contains `JARVIS-Desktop-Setup.exe`, its blockmap, and `latest.yml`.
- [ ] Confirm the website production deployment is ready and its download URL resolves to the published installer.
- [ ] Report that existing installations need this one manual installer update before future automatic updates work.
