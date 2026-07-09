# Runtime Pet Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users replace all eight JARVIS Desktop state images through a hot-reloaded environment file using local paths or HTTP(S) URLs.

**Architecture:** A pure main-process loader parses and validates `jarvis-pet.env`, then Electron watches the file and publishes a typed override map through preload IPC. The renderer merges overrides over bundled defaults and uses an explicit visual-state selector for dragging, listening, thinking, approval, denial, approval acceptance, talking, and idle.

**Tech Stack:** Electron 33, TypeScript, React 18, Node.js built-in test runner, Vite, PowerShell updater

---

## File Structure

- Create `desktop/src/main/pet-images.ts`: parse, merge, validate, and resolve runtime image configuration.
- Create `desktop/src/shared/pet-visual-state.ts`: pure visual-state priority selector shared with tests.
- Create `desktop/test/pet-images.test.mjs`: loader behavior tests against compiled main-process output.
- Create `desktop/test/pet-visual-state.test.mjs`: visual-state behavior tests against compiled shared output.
- Modify `desktop/src/shared/types.ts`: image state/map types and preload API methods.
- Modify `desktop/src/main.ts`: environment path, file watcher, IPC handlers, and renderer notifications.
- Modify `desktop/src/preload.cts`: safe initial-load and changed-event bridge.
- Modify `desktop/src/renderer/App.tsx`: runtime image map, hot reload, explicit state transitions, and fallback handling.
- Modify `desktop/src/renderer/app.css`: dragging and approved animation hooks.
- Create `jarvis-pet.env.example`: documented image variables.
- Modify `.gitignore`: ignore the user-owned `jarvis-pet.env`.
- Modify `scripts/update-desktop-local.ps1`: seed but never overwrite installed runtime configuration.
- Modify `scripts/check-desktop-electron.mjs`: assert the complete runtime contract.
- Modify `desktop/package.json`: expose focused test commands.

### Task 1: Runtime Image Loader

**Files:**
- Create: `desktop/test/pet-images.test.mjs`
- Create: `desktop/src/main/pet-images.ts`
- Modify: `desktop/package.json`

- [ ] **Step 1: Add the failing loader tests**

Create tests using a temporary directory and import the not-yet-created compiled module:

```js
import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPetImages, parsePetImageEnv } from "../dist/main/pet-images.js";

test("parses quoted values and ignores comments and blanks", () => {
  assert.deepEqual(
    parsePetImageEnv(`
# images
JARVIS_PET_IDLE_IMAGE="C:\\Pets\\idle.png"
JARVIS_PET_TALKING_IMAGE='https://example.com/talking.png'
EMPTY=
`),
    {
      JARVIS_PET_IDLE_IMAGE: "C:\\Pets\\idle.png",
      JARVIS_PET_TALKING_IMAGE: "https://example.com/talking.png",
    },
  );
});

test("loads local files and URLs while process variables take precedence", async (t) => {
  const dir = join(tmpdir(), `jarvis-pet-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const idle = join(dir, "idle.png");
  await writeFile(idle, "image");
  const envFile = join(dir, "jarvis-pet.env");
  await writeFile(envFile, [
    `JARVIS_PET_IDLE_IMAGE=${idle}`,
    "JARVIS_PET_LISTENING_IMAGE=https://example.com/listening.png",
    "JARVIS_PET_THINKING_IMAGE=relative.png",
  ].join("\n"));

  const result = loadPetImages(envFile, {
    JARVIS_PET_LISTENING_IMAGE: "https://cdn.example.com/listening.png",
  });

  assert.match(result.idle, /^file:\/\//);
  assert.equal(result.listening, "https://cdn.example.com/listening.png");
  assert.equal(result.thinking, undefined);
});

test("returns no overrides when the environment file is missing", () => {
  assert.deepEqual(loadPetImages("Z:\\missing\\jarvis-pet.env", {}), {});
});
```

- [ ] **Step 2: Add test scripts and verify RED**

Add these scripts to `desktop/package.json`:

```json
"test:pet-images": "npm run build:main && node --test test/pet-images.test.mjs",
"test:pet-state": "npm run build:main && node --test test/pet-visual-state.test.mjs",
"test": "npm run test:pet-images && npm run test:pet-state"
```

Run:

```powershell
npm --prefix desktop run test:pet-images
```

Expected: FAIL because `dist/main/pet-images.js` does not exist.

- [ ] **Step 3: Implement the typed loader**

Create `desktop/src/main/pet-images.ts` with:

```ts
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { PetImageOverrides, PetVisualState } from "../shared/types.js";

export const PET_IMAGE_ENV_KEYS: Record<PetVisualState, string> = {
  idle: "JARVIS_PET_IDLE_IMAGE",
  dragging: "JARVIS_PET_DRAGGING_IMAGE",
  listening: "JARVIS_PET_LISTENING_IMAGE",
  thinking: "JARVIS_PET_THINKING_IMAGE",
  approval: "JARVIS_PET_APPROVAL_IMAGE",
  denied: "JARVIS_PET_DENIED_IMAGE",
  approved: "JARVIS_PET_APPROVED_IMAGE",
  talking: "JARVIS_PET_TALKING_IMAGE",
};

export function parsePetImageEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) values[key] = value;
  }
  return values;
}

function resolveImage(value: string): string | undefined {
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }
  if (!isAbsolute(value) || !existsSync(value)) return undefined;
  return pathToFileURL(value).toString();
}

export function loadPetImages(
  envFilePath: string,
  processValues: NodeJS.ProcessEnv = process.env,
): PetImageOverrides {
  const fileValues = existsSync(envFilePath)
    ? parsePetImageEnv(readFileSync(envFilePath, "utf8"))
    : {};
  const images: PetImageOverrides = {};
  for (const [state, key] of Object.entries(PET_IMAGE_ENV_KEYS) as [PetVisualState, string][]) {
    const value = processValues[key]?.trim() || fileValues[key];
    const resolved = value ? resolveImage(value) : undefined;
    if (resolved) images[state] = resolved;
  }
  return images;
}
```

- [ ] **Step 4: Add the shared image types**

In `desktop/src/shared/types.ts`, add:

```ts
export type PetVisualState =
  | "idle"
  | "dragging"
  | "listening"
  | "thinking"
  | "approval"
  | "denied"
  | "approved"
  | "talking";

export type PetImageOverrides = Partial<Record<PetVisualState, string>>;
```

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
npm --prefix desktop run test:pet-images
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```powershell
git add desktop/package.json desktop/src/main/pet-images.ts desktop/src/shared/types.ts desktop/test/pet-images.test.mjs
git commit -m "Add runtime pet image loader"
```

### Task 2: Visual-State Priority

**Files:**
- Create: `desktop/test/pet-visual-state.test.mjs`
- Create: `desktop/src/shared/pet-visual-state.ts`

- [ ] **Step 1: Write the failing state-priority tests**

Create `desktop/test/pet-visual-state.test.mjs`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { selectPetVisualState } from "../dist/shared/pet-visual-state.js";

test("dragging overrides every other visual state", () => {
  assert.equal(selectPetVisualState({
    dragging: true,
    transient: "approved",
    hasPendingAction: true,
    mode: "speaking",
  }), "dragging");
});

test("explicit approval result overrides mode and pending action", () => {
  assert.equal(selectPetVisualState({
    dragging: false,
    transient: "denied",
    hasPendingAction: true,
    mode: "thinking",
  }), "denied");
});

test("maps pending action and activity modes to visual states", () => {
  assert.equal(selectPetVisualState({ dragging: false, transient: null, hasPendingAction: true, mode: "idle" }), "approval");
  assert.equal(selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "listening" }), "listening");
  assert.equal(selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "thinking" }), "thinking");
  assert.equal(selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "speaking" }), "talking");
  assert.equal(selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "offline" }), "idle");
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm --prefix desktop run test:pet-state
```

Expected: FAIL because `dist/shared/pet-visual-state.js` does not exist.

- [ ] **Step 3: Implement the selector**

Create `desktop/src/shared/pet-visual-state.ts`:

```ts
import type { PetMode, PetVisualState } from "./types.js";

export type PetVisualStateInput = {
  dragging: boolean;
  transient: "approved" | "denied" | null;
  hasPendingAction: boolean;
  mode: PetMode;
};

export function selectPetVisualState(input: PetVisualStateInput): PetVisualState {
  if (input.dragging) return "dragging";
  if (input.transient) return input.transient;
  if (input.hasPendingAction) return "approval";
  if (input.mode === "listening") return "listening";
  if (input.mode === "thinking") return "thinking";
  if (input.mode === "speaking") return "talking";
  return "idle";
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```powershell
npm --prefix desktop run test:pet-state
```

Expected: 3 tests pass.

```powershell
git add desktop/src/shared/pet-visual-state.ts desktop/test/pet-visual-state.test.mjs
git commit -m "Define desktop pet visual states"
```

### Task 3: Electron IPC and Hot Reload

**Files:**
- Modify: `desktop/src/shared/types.ts`
- Modify: `desktop/src/preload.cts`
- Modify: `desktop/src/main.ts`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Extend the contract check first**

Add assertions to `scripts/check-desktop-electron.mjs` that require:

```js
const petImages = read("desktop/src/main/pet-images.ts");
assert(/desktop:getPetImages/.test(main), "main process must expose runtime pet images");
assert(/desktop:petImagesChanged/.test(main), "main process must publish pet image changes");
assert(/watchFile/.test(main), "main process must watch runtime pet image configuration");
assert(/getPetImages/.test(preload), "preload must expose initial runtime pet images");
assert(/onPetImagesChanged/.test(preload), "preload must expose hot pet image updates");
assert(/JARVIS_PET_DRAGGING_IMAGE/.test(petImages), "pet image loader must support dragging");
assert(/JARVIS_PET_APPROVED_IMAGE/.test(petImages), "pet image loader must support approved actions");
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: FAIL at `desktop:getPetImages`.

- [ ] **Step 3: Extend shared and preload APIs**

Add to `JarvisDesktopApi`:

```ts
getPetImages(): Promise<PetImageOverrides>;
onPetImagesChanged(listener: (images: PetImageOverrides) => void): () => void;
```

Implement in `desktop/src/preload.cts`:

```ts
getPetImages: () => ipcRenderer.invoke("desktop:getPetImages"),
onPetImagesChanged: (listener) => {
  const handler = (_event: Electron.IpcRendererEvent, images: PetImageOverrides) => listener(images);
  ipcRenderer.on("desktop:petImagesChanged", handler);
  return () => ipcRenderer.removeListener("desktop:petImagesChanged", handler);
},
```

- [ ] **Step 4: Add main-process load and watch behavior**

In `desktop/src/main.ts`:

```ts
import { watchFile, unwatchFile } from "node:fs";
import { loadPetImages } from "./main/pet-images.js";

function petImagesEnvPath() {
  return app.isPackaged
    ? join(dirname(process.execPath), "jarvis-pet.env")
    : join(mainDir, "../../jarvis-pet.env");
}

function currentPetImages() {
  return loadPetImages(petImagesEnvPath());
}

function startPetImageWatcher() {
  const path = petImagesEnvPath();
  let timer: NodeJS.Timeout | undefined;
  watchFile(path, { interval: 500 }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      petWindow?.webContents.send("desktop:petImagesChanged", currentPetImages());
    }, 150);
  });
}
```

Register:

```ts
ipcMain.handle("desktop:getPetImages", () => currentPetImages());
```

Call `startPetImageWatcher()` after `createPetWindow()`, and call `unwatchFile(petImagesEnvPath())` during `before-quit`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run typecheck
```

Expected: contract check passes and TypeScript exits 0.

- [ ] **Step 6: Commit**

```powershell
git add desktop/src/main.ts desktop/src/preload.cts desktop/src/shared/types.ts scripts/check-desktop-electron.mjs
git commit -m "Hot reload desktop pet images"
```

### Task 4: Renderer Image Overrides and Interaction States

**Files:**
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `desktop/src/renderer/app.css`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Add renderer contract assertions**

Add:

```js
assert(/selectPetVisualState/.test(app), "renderer must select explicit pet visual states");
assert(/onPetImagesChanged/.test(app), "renderer must hot reload image overrides");
assert(/setDragging\(true\)/.test(app), "renderer must show a dragging image after movement begins");
assert(/setTransientState\("approved"\)/.test(app), "renderer must show approved while an action runs");
assert(/setTransientState\("denied"\)/.test(app), "renderer must show denied after rejecting an action");
assert(/onError=/.test(app), "renderer must fall back when an override image fails");
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: FAIL at `selectPetVisualState`.

- [ ] **Step 3: Replace inferred moods with explicit visual state**

In `App.tsx`, create bundled defaults:

```ts
const bundledPetImages: Record<PetVisualState, string> = {
  idle: idlePet,
  dragging: idlePet,
  listening: listeningPet,
  thinking: thinkingPet,
  approval: approvalPet,
  denied: deniedPet,
  approved: approvalPet,
  talking: talkingPet,
};
```

Add state:

```ts
const [petImages, setPetImages] = useState<PetImageOverrides>({});
const [dragging, setDragging] = useState(false);
const [transientState, setTransientState] = useState<"approved" | "denied" | null>(null);
const transientTimerRef = useRef<number | null>(null);
```

Load and subscribe:

```ts
useEffect(() => {
  void window.jarvisDesktop.getPetImages().then(setPetImages);
  return window.jarvisDesktop.onPetImagesChanged(setPetImages);
}, []);
```

Select:

```ts
const petVisualState = selectPetVisualState({
  dragging,
  transient: transientState,
  hasPendingAction: Boolean(pendingAction),
  mode,
});
const petImage = petImages[petVisualState] || bundledPetImages[petVisualState];
```

- [ ] **Step 4: Wire dragging and approval-result transitions**

When pointer movement passes the threshold, call `setDragging(true)`. On pointer up and pointer cancellation, call `setDragging(false)`.

In `continuePendingAction`, call `setTransientState("approved")` before awaiting `runLocalAction`, then clear it before entering speaking or idle.

In `stopPendingAction`, when an approval was pending, call:

```ts
setTransientState("denied");
if (transientTimerRef.current) window.clearTimeout(transientTimerRef.current);
transientTimerRef.current = window.setTimeout(() => setTransientState(null), 1400);
```

Use `pet-${petVisualState}` as the animation class. Add an image fallback:

```tsx
<img
  key={`${petVisualState}:${petImage}`}
  src={petImage}
  alt=""
  draggable={false}
  onError={(event) => {
    const fallback = bundledPetImages[petVisualState];
    if (event.currentTarget.src !== fallback) event.currentTarget.src = fallback;
  }}
/>
```

- [ ] **Step 5: Add state-specific motion**

In `app.css`, add:

```css
.pet-dragging .pet-character img {
  animation: dragging-tilt 0.5s ease-in-out infinite alternate;
}

.pet-approved .pet-character img {
  animation: approved-pop 0.8s ease-in-out infinite alternate;
}

@keyframes dragging-tilt {
  from { transform: rotate(-2deg) scale(0.99); }
  to { transform: rotate(2deg) scale(1.01); }
}

@keyframes approved-pop {
  from { transform: translateY(0) scale(1); }
  to { transform: translateY(-5px) scale(1.025); }
}
```

- [ ] **Step 6: Verify GREEN**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run test
npm --prefix desktop run typecheck
npm --prefix desktop run build:renderer
```

Expected: all contract and unit tests pass, TypeScript exits 0, and Vite builds all bundled images.

- [ ] **Step 7: Commit**

```powershell
git add desktop/src/renderer/App.tsx desktop/src/renderer/app.css scripts/check-desktop-electron.mjs
git commit -m "Use configurable pet images for every state"
```

### Task 5: User Configuration and Update Preservation

**Files:**
- Create: `jarvis-pet.env.example`
- Modify: `.gitignore`
- Modify: `scripts/update-desktop-local.ps1`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Add failing packaging assertions**

Add:

```js
const petEnvExample = read("jarvis-pet.env.example");
for (const key of [
  "IDLE", "DRAGGING", "LISTENING", "THINKING",
  "APPROVAL", "DENIED", "APPROVED", "TALKING",
]) {
  assert(petEnvExample.includes(`JARVIS_PET_${key}_IMAGE=`), `pet env example must include ${key}`);
}
assert(/jarvis-pet\.env/.test(gitignore), "user pet image environment file must be ignored");
assert(/jarvis-pet\.env\.example/.test(localUpdater), "updater must seed pet image configuration");
assert(/Test-Path \$installedPetEnv/.test(localUpdater), "updater must preserve existing pet image configuration");
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: FAIL because `jarvis-pet.env.example` is missing.

- [ ] **Step 3: Add the example configuration**

Create `jarvis-pet.env.example`:

```env
# Use an absolute Windows path or an HTTP(S) URL. Blank values use bundled images.
JARVIS_PET_IDLE_IMAGE=
JARVIS_PET_DRAGGING_IMAGE=
JARVIS_PET_LISTENING_IMAGE=
JARVIS_PET_THINKING_IMAGE=
JARVIS_PET_APPROVAL_IMAGE=
JARVIS_PET_DENIED_IMAGE=
JARVIS_PET_APPROVED_IMAGE=
JARVIS_PET_TALKING_IMAGE=
```

Add `/jarvis-pet.env` to `.gitignore`.

- [ ] **Step 4: Seed without overwriting**

In `scripts/update-desktop-local.ps1`, after copying `win-unpacked`, add:

```powershell
$installedPetEnv = Join-Path $InstallDir "jarvis-pet.env"
$petEnvExample = Join-Path $repoRoot "jarvis-pet.env.example"
if (-not (Test-Path $installedPetEnv)) {
  Copy-Item -LiteralPath $petEnvExample -Destination $installedPetEnv
}
```

This creates the editable file on first update and leaves later user changes intact.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: Desktop Electron check passes.

```powershell
git add .gitignore jarvis-pet.env.example scripts/update-desktop-local.ps1 scripts/check-desktop-electron.mjs
git commit -m "Add editable desktop pet image environment"
```

### Task 6: Full Verification, Install, and Push

**Files:**
- Verify all changed files

- [ ] **Step 1: Run the full verification suite**

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run test
npm --prefix desktop run typecheck
npm --prefix desktop run build:main
npm --prefix desktop run build:renderer
git diff --check
```

Expected: all tests and builds exit 0; `git diff --check` reports no errors.

- [ ] **Step 2: Build and install the updated app**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-desktop-local.ps1 -SkipWebBuild
```

Expected: existing JARVIS processes stop, the desktop package builds, files copy to `Downloads\JARVIS Desktop`, `jarvis-pet.env` is created only if absent, and one updated app launches.

- [ ] **Step 3: Verify installed runtime configuration**

Confirm:

```powershell
Get-Item "$HOME\Downloads\JARVIS Desktop\jarvis-pet.env"
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "JARVIS Desktop.exe" -and $_.ParentProcessId -notin (Get-Process -Name "JARVIS Desktop").Id }
```

Expected: the environment file exists and there is one root JARVIS Desktop process.

- [ ] **Step 4: Commit any verification-only contract adjustment**

If verification required a contract-only correction, stage only that correction and commit:

```powershell
git add scripts/check-desktop-electron.mjs
git commit -m "Verify runtime pet image states"
```

If no correction was needed, do not create an empty commit.

- [ ] **Step 5: Push the branch**

```powershell
git push -u origin codex/jarvis-desktop-pet
```

Expected: the remote branch advances to the final local commit.
