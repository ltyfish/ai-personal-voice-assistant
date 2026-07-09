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

export function shouldRestoreIdleAfterDrag(
  previous: PetVisualState | null,
  current: PetVisualState,
) {
  return previous === "dragging" && current === "idle";
}
