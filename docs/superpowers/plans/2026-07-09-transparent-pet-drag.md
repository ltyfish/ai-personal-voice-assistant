# Transparent Pet Drag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the translucent pet hover/drag rectangle and preserve the current idle image after dragging.

**Architecture:** A tested visual-transition helper identifies only the `dragging` to `idle` transition, allowing the renderer to restore its per-state idle history without rerolling. Pet-specific interaction selectors override the later generic button hover and active rules while preserving cursor and keyboard behavior.

**Tech Stack:** React, TypeScript, CSS, Node.js built-in test runner, Electron

---

## File Structure

- Modify `desktop/src/shared/pet-visual-state.ts`: expose drag-to-idle restoration decision.
- Modify `desktop/test/pet-visual-state.test.mjs`: test restoration boundaries.
- Modify `desktop/src/renderer/App.tsx`: remember the previous visual state and restore idle history.
- Modify `desktop/src/renderer/app.css`: force transparent pet interaction states.
- Modify `scripts/check-desktop-electron.mjs`: enforce both integration points.

### Task 1: Preserve Idle Across Drag

**Files:**
- Modify: `desktop/test/pet-visual-state.test.mjs`
- Modify: `desktop/src/shared/pet-visual-state.ts`
- Modify: `desktop/src/renderer/App.tsx`
- Modify: `scripts/check-desktop-electron.mjs`

- [ ] **Step 1: Write the failing transition test**

Import `shouldRestoreIdleAfterDrag` and add:

```js
test("restores idle only when leaving the dragging state", () => {
  assert.equal(shouldRestoreIdleAfterDrag("dragging", "idle"), true);
  assert.equal(shouldRestoreIdleAfterDrag("thinking", "idle"), false);
  assert.equal(shouldRestoreIdleAfterDrag("dragging", "thinking"), false);
  assert.equal(shouldRestoreIdleAfterDrag(null, "idle"), false);
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm --prefix desktop run test:pet-state
```

Expected: FAIL because `shouldRestoreIdleAfterDrag` is not exported.

- [ ] **Step 3: Implement the minimal helper**

Add to `desktop/src/shared/pet-visual-state.ts`:

```ts
export function shouldRestoreIdleAfterDrag(
  previous: PetVisualState | null,
  current: PetVisualState,
) {
  return previous === "dragging" && current === "idle";
}
```

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
npm --prefix desktop run test:pet-state
```

Expected: 4 tests pass.

- [ ] **Step 5: Add a failing renderer contract**

Add:

```js
assert(/previousPetVisualStateRef/.test(app), "renderer must remember the previous visual state");
assert(/shouldRestoreIdleAfterDrag/.test(app), "renderer must restore idle after dragging");
assert(/lastPetImagesRef\.current\.idle/.test(app), "renderer must reuse the selected idle image");
```

Run `node scripts/check-desktop-electron.mjs`.

Expected: FAIL at the missing previous-state reference.

- [ ] **Step 6: Integrate restoration**

Import `shouldRestoreIdleAfterDrag`, add:

```ts
const previousPetVisualStateRef = useRef<PetVisualState | null>(null);
```

Replace the visual-state selection effect with:

```ts
useEffect(() => {
  const previous = previousPetVisualStateRef.current;
  previousPetVisualStateRef.current = petVisualState;
  if (shouldRestoreIdleAfterDrag(previous, petVisualState)) {
    setPetImage(lastPetImagesRef.current.idle || bundledPetImages.idle);
    return;
  }
  choosePetImage(petVisualState);
}, [choosePetImage, petVisualState]);
```

- [ ] **Step 7: Verify and commit**

Run:

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run test:pet-state
npm --prefix desktop run typecheck
```

Expected: contract check, 4 state tests, and typecheck pass.

```powershell
git add desktop/src/shared/pet-visual-state.ts desktop/test/pet-visual-state.test.mjs desktop/src/renderer/App.tsx scripts/check-desktop-electron.mjs
git commit -m "Preserve idle image after dragging"
```

### Task 2: Remove Pet Interaction Overlay

**Files:**
- Modify: `scripts/check-desktop-electron.mjs`
- Modify: `desktop/src/renderer/app.css`

- [ ] **Step 1: Add the failing CSS contract**

Add:

```js
const appCss = read("desktop/src/renderer/app.css");
assert(
  /\.pet-character:hover:not\(:disabled\)[^{]*\{[^}]*background:\s*transparent/.test(appCss),
  "pet hover must remain transparent",
);
assert(
  /\.pet-character:active:not\(:disabled\)[^{]*\{[^}]*transform:\s*none/.test(appCss),
  "pet active state must not inherit generic button translation",
);
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
node scripts/check-desktop-electron.mjs
```

Expected: FAIL at `pet hover must remain transparent`.

- [ ] **Step 3: Add pet-specific interaction overrides**

After the generic button active rule in `desktop/src/renderer/app.css`, add:

```css
.pet-character:hover:not(:disabled),
.pet-character:focus-visible {
  border-color: transparent;
  background: transparent;
}

.pet-character:active:not(:disabled) {
  border-color: transparent;
  background: transparent;
  transform: none;
}
```

- [ ] **Step 4: Run full verification**

```powershell
node scripts/check-desktop-electron.mjs
npm --prefix desktop run test
npm --prefix desktop run typecheck
npm --prefix desktop run build:main
npm --prefix desktop run build:renderer
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```powershell
git add desktop/src/renderer/app.css scripts/check-desktop-electron.mjs
git commit -m "Keep pet interactions transparent"
```

- [ ] **Step 6: Install and push**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-desktop-local.ps1 -SkipWebBuild
git push -u origin codex/jarvis-desktop-pet
```

Expected: the app packages and relaunches once, then the remote branch advances.
