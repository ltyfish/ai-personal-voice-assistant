import assert from "node:assert/strict";
import test from "node:test";
import { selectPetVisualState } from "../dist/shared/pet-visual-state.js";

test("dragging overrides every other visual state", () => {
  assert.equal(
    selectPetVisualState({
      dragging: true,
      transient: "approved",
      hasPendingAction: true,
      mode: "speaking",
    }),
    "dragging",
  );
});

test("explicit approval result overrides mode and pending action", () => {
  assert.equal(
    selectPetVisualState({
      dragging: false,
      transient: "denied",
      hasPendingAction: true,
      mode: "thinking",
    }),
    "denied",
  );
});

test("maps pending action and activity modes to visual states", () => {
  assert.equal(
    selectPetVisualState({ dragging: false, transient: null, hasPendingAction: true, mode: "idle" }),
    "approval",
  );
  assert.equal(
    selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "listening" }),
    "listening",
  );
  assert.equal(
    selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "thinking" }),
    "thinking",
  );
  assert.equal(
    selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "speaking" }),
    "talking",
  );
  assert.equal(
    selectPetVisualState({ dragging: false, transient: null, hasPendingAction: false, mode: "offline" }),
    "idle",
  );
});
