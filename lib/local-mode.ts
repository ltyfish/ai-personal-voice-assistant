"use client";

// Voice mode is automatic now:
//   bridge online  -> run JARVIS's local tool loop.
//   bridge offline -> fall back to the cloud voice route.
// Keep these helpers as a tiny compatibility layer for older imports/storage.

export type ModelMode = "local";

const KEY = "local.modelMode";

export function getModelMode(): ModelMode {
  return "local";
}

export function setModelMode(_mode: ModelMode) {
  if (typeof window === "undefined") return;
  localStorage.setItem(KEY, "local");
  window.dispatchEvent(new CustomEvent("jarvis-modelmode", { detail: "local" }));
}
