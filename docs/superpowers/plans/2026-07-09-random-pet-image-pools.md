# Random Pet Image Pools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support comma-separated image pools for all pet states, with no immediate repeats and five-minute idle rotation.

**Architecture:** The main-process loader resolves each environment value into a URL array. A pure shared selector chooses a candidate while excluding the previous or failed image, and the renderer rerolls only on state entry, configuration reload, image failure, or the idle timer.

**Tech Stack:** Electron, TypeScript, React, Node.js built-in test runner, Vite

---

## File Structure

- Modify `desktop/src/main/pet-images.ts`: parse and resolve comma-separated image lists.
- Modify `desktop/src/shared/types.ts`: change single image overrides into image pool arrays.
- Modify `desktop/test/pet-images.test.mjs`: verify list parsing, invalid-item omission, and precedence.
- Create `desktop/src/shared/random-pet-image.ts`: pure no-repeat random selector.
- Create `desktop/test/random-pet-image.test.mjs`: deterministic selector tests.
- Modify `desktop/package.json`: run the new selector test.
- Modify `desktop/src/renderer/App.tsx`: per-state history, failure exclusions, state-entry rerolls, and idle timer.
- Modify `jarvis-pet.env.example`: document comma-separated values.
- Modify `scripts/check-desktop-electron.mjs`: enforce runtime timing and selection integration.

### Task 1: Image Pool Loader

**Files:**
- Modify: `desktop/test/pet-images.test.mjs`
- Modify: `desktop/src/main/pet-images.ts`
- Modify: `desktop/src/shared/types.ts`

- [ ] **Step 1: Change loader tests to require arrays**

Add a direct list parser test and update loader assertions:

```js
import {
  loadPetImages,
  parsePetImageEnv,
  parsePetImageList,
} from "../dist/main/pet-images.js";

test("parses comma-separated image items with optional quotes", () => {
  assert.deepEqual(
    parsePetImageList(` C:\\Pets\\one.png, "C:\\Pets\\two.png", 'https://example.com/three.png', , `),
    [
      "C:\\Pets\\one.png",
      "C:\\Pets\\two.png",
      "https://example.com/three.png",
    ],
  );
});
```

Write two temporary local image files and configure:

```js
await writeFile(envFile, [
  `JARVIS_PET_IDLE_IMAGE=${idle}, ${idleTwo}, missing.png`,
  "JARVIS_PET_LISTENING_IMAGE=https://example.com/listening.png, https://example.com/listening-2.png",
].join("\n"));
```

Assert:

```js
assert.equal(result.idle.length, 2);
assert.ok(result.idle.every((image) => image.startsWith("file://")));
assert.deepEqual(result.listening, [
  "https://cdn.example.com/listening.png",
  "https://cdn.example.com/listening-2.png",
]);
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm --prefix desktop run test:pet-images
```

Expected: FAIL because `parsePetImageList` is not exported and loader values are strings.

- [ ] **Step 3: Change the shared IPC type**

Replace `PetImageOverrides` with:

```ts
export type PetImagePools = Partial<Record<PetVisualState, string[]>>;
```

Update `JarvisDesktopApi`:

```ts
getPetImages(): Promise<PetImagePools>;
onPetImagesChanged(listener: (images: PetImagePools) => void): () => void;
```

- [ ] **Step 4: Implement list parsing and per-item resolution**

In `desktop/src/main/pet-images.ts`, add:

```ts
function unquote(value: string) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

export function parsePetImageList(value: string): string[] {
  return value
    .split(",")
    .map((item) => unquote(item.trim()))
    .filter(Boolean);
}
```

Adjust `parsePetImageEnv` so whole-value quotes are removed only for single-item values:

```ts
if (
  !value.includes(",") &&
  value.length >= 2 &&
  ((value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'")))
) {
  value = value.slice(1, -1);
}
```

Change `loadPetImages` to return `PetImagePools` and resolve every item:

```ts
const resolved = parsePetImageList(value)
  .map(resolveImage)
  .filter((image): image is string => Boolean(image));
const unique = [...new Set(resolved)];
if (unique.length) images[state] = unique;
```

Process environment values continue to replace the complete file list.

- [ ] **Step 5: Update preload naming and verify GREEN**

Replace `PetImageOverrides` imports/usages in `desktop/src/preload.cts` and `desktop/src/renderer/App.tsx` with `PetImagePools` so the project compiles.

Until Task 3 adds random selection, use the first configured item in `App.tsx`:

```ts
const petImage = petImagePools[petVisualState]?.[0] || bundledPetImages[petVisualState];
```

Run:

```powershell
npm --prefix desktop run test:pet-images
npm --prefix desktop run typecheck
```

Expected: loader tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit**

```powershell
git add desktop/src/main/pet-images.ts desktop/src/shared/types.ts desktop/src/preload.cts desktop/src/renderer/App.tsx desktop/test/pet-images.test.mjs
git commit -m "Support pet image pools"
```

### Task 2: No-Repeat Random Selector

**Files:**
- Create: `desktop/test/random-pet-image.test.mjs`
- Create: `desktop/src/shared/random-pet-image.ts`
- Modify: `desktop/package.json`

- [ ] **Step 1: Write deterministic failing tests**

Create:

```js
import assert from "node:assert/strict";
import test from "node:test";
import { selectRandomPetImage } from "../dist/shared/random-pet-image.js";

test("returns the only usable image", () => {
  assert.equal(selectRandomPetImage(["one"], undefined, new Set(), () => 0.8), "one");
});

test("does not immediately repeat when alternatives exist", () => {
  assert.equal(selectRandomPetImage(["one", "two", "three"], "one", new Set(), () => 0), "two");
});

test("uses deterministic random boundaries", () => {
  assert.equal(selectRandomPetImage(["one", "two", "three"], undefined, new Set(), () => 0), "one");
  assert.equal(selectRandomPetImage(["one", "two", "three"], undefined, new Set(), () => 0.999), "three");
});

test("omits failed images and returns undefined when none remain", () => {
  assert.equal(selectRandomPetImage(["one", "two"], undefined, new Set(["one"]), () => 0), "two");
  assert.equal(selectRandomPetImage(["one"], undefined, new Set(["one"]), () => 0), undefined);
});
```

Add:

```json
"test:pet-random": "npm run build:main && node --test test/random-pet-image.test.mjs",
"test": "npm run test:pet-images && npm run test:pet-state && npm run test:pet-random"
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm --prefix desktop run test:pet-random
```

Expected: FAIL because `dist/shared/random-pet-image.js` does not exist.

- [ ] **Step 3: Implement the selector**

Create:

```ts
export function selectRandomPetImage(
  pool: readonly string[],
  previous: string | undefined,
  excluded: ReadonlySet<string>,
  random: () => number = Math.random,
): string | undefined {
  const usable = pool.filter((image) => !excluded.has(image));
  if (!usable.length) return undefined;
  const candidates = usable.length > 1
    ? usable.filter((image) => image !== previous)
    : usable;
  const bounded = Math.min(Math.max(random(), 0), 0.999999999);
  return candidates[Math.floor(bounded * candidates.length)];
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```powershell
npm --prefix desktop run test:pet-random
```

Expected: 4 tests pass.

```powershell
git add desktop/package.json desktop/src/shared/random-pet-image.ts desktop/test/random-pet-image.test.mjs
git commit -m "Add no-repeat pet image selection"
```

### Task 3: Renderer State Rerolling and Idle Rotation

**Files:**
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Add failing renderer contract checks**

Add:

```js
assert(/selectRandomPetImage/.test(app), "renderer must randomly select from image pools");
assert(/lastPetImagesRef/.test(app), "renderer must remember the previous image per state");
assert(/failedPetImagesRef/.test(app), "renderer must exclude failed remote images");
assert(/300_000/.test(app), "idle image pool must rotate every five minutes");
assert(/setInterval/.test(app), "renderer must schedule idle image rotation");
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: FAIL at random pool selection.

- [ ] **Step 3: Add per-state selection state**

In `App.tsx`, import `useCallback`, `selectRandomPetImage`, and `PetImagePools`. Replace the old direct lookup with:

```ts
const [petImagePools, setPetImagePools] = useState<PetImagePools>({});
const [petImage, setPetImage] = useState(bundledPetImages.idle);
const lastPetImagesRef = useRef<Partial<Record<PetVisualState, string>>>({});
const failedPetImagesRef = useRef<Partial<Record<PetVisualState, Set<string>>>>({});

const choosePetImage = useCallback((state: PetVisualState, pools = petImagePools) => {
  const failed = failedPetImagesRef.current[state] || new Set<string>();
  const selected = selectRandomPetImage(
    pools[state] || [],
    lastPetImagesRef.current[state],
    failed,
  ) || bundledPetImages[state];
  lastPetImagesRef.current[state] = selected;
  setPetImage(selected);
}, [petImagePools]);
```

- [ ] **Step 4: Reroll on state and configuration changes**

Replace the existing image subscription with:

```ts
useEffect(() => {
  let active = true;
  void window.jarvisDesktop.getPetImages().then((pools) => {
    if (!active) return;
    failedPetImagesRef.current = {};
    setPetImagePools(pools);
  });
  const unsubscribe = window.jarvisDesktop.onPetImagesChanged((pools) => {
    failedPetImagesRef.current = {};
    setPetImagePools(pools);
  });
  return () => {
    active = false;
    unsubscribe();
  };
}, []);

useEffect(() => {
  choosePetImage(petVisualState);
}, [choosePetImage, petVisualState]);
```

Because `choosePetImage` changes when pools change, hot reload rerolls the active state immediately.

- [ ] **Step 5: Add idle rotation and remote failure retry**

Add:

```ts
useEffect(() => {
  if (petVisualState !== "idle") return;
  const timer = window.setInterval(() => choosePetImage("idle"), 300_000);
  return () => window.clearInterval(timer);
}, [choosePetImage, petVisualState]);
```

Replace the image error handler with:

```ts
onError={() => {
  if (petImage === bundledPetImages[petVisualState]) return;
  const failed = failedPetImagesRef.current[petVisualState] || new Set<string>();
  failed.add(petImage);
  failedPetImagesRef.current[petVisualState] = failed;
  choosePetImage(petVisualState);
}}
```

- [ ] **Step 6: Verify GREEN and commit**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run test
npm --prefix desktop run typecheck
npm --prefix desktop run build:renderer
```

Expected: contract checks, 10 unit tests, typecheck, and renderer build pass.

```powershell
git add desktop/src/renderer/App.tsx scripts/check-desktop-electron.mjs
git commit -m "Randomize pet images by state"
```

### Task 4: Documentation, Installation, and Push

**Files:**
- Modify: `jarvis-pet.env.example`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Add a failing example-file assertion**

Require the example to demonstrate commas:

```js
assert(
  /JARVIS_PET_IDLE_IMAGE=.*,.*/.test(petEnvExample),
  "pet env example must demonstrate comma-separated image pools",
);
```

Run `node scripts/check-desktop-electron.mjs`.

Expected: FAIL because the example values are blank.

- [ ] **Step 2: Document pool syntax**

Change the first example lines to:

```env
# Add one or more absolute paths or HTTP(S) URLs separated by commas.
# The same image is not selected twice in a row. Idle changes every five minutes.
JARVIS_PET_IDLE_IMAGE=C:\Pets\idle-1.png, C:\Pets\idle-2.png
JARVIS_PET_DRAGGING_IMAGE=C:\Pets\drag-1.png, C:\Pets\drag-2.png
```

Keep the remaining variables present with empty values.

- [ ] **Step 3: Run full verification**

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run test
npm --prefix desktop run typecheck
npm --prefix desktop run build:main
npm --prefix desktop run build:renderer
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 4: Commit documentation**

```powershell
git add jarvis-pet.env.example scripts/check-desktop-electron.mjs
git commit -m "Document random pet image pools"
```

- [ ] **Step 5: Build and install**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-desktop-local.ps1 -SkipWebBuild
```

Expected: the app packages, the existing installed `jarvis-pet.env` remains unchanged, and one updated JARVIS instance launches.

- [ ] **Step 6: Push**

```powershell
git push -u origin codex/jarvis-desktop-pet
```

Expected: the remote branch advances to the final commit.
