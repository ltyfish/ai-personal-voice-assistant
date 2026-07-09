import assert from "node:assert/strict";
import test from "node:test";
import { initialUpdateStatus, reduceUpdateEvent } from "../dist/shared/update-state.js";

test("maps updater lifecycle events to renderer-safe states", () => {
  assert.deepEqual(reduceUpdateEvent(initialUpdateStatus, { type: "checking" }), { state: "checking" });
  assert.deepEqual(reduceUpdateEvent(initialUpdateStatus, { type: "available", version: "0.1.7" }), {
    state: "available",
    version: "0.1.7",
  });
  assert.deepEqual(reduceUpdateEvent(initialUpdateStatus, { type: "progress", percent: 42.4 }), {
    state: "downloading",
    percent: 42,
  });
  assert.deepEqual(reduceUpdateEvent(initialUpdateStatus, { type: "downloaded", version: "0.1.7" }), {
    state: "ready",
    version: "0.1.7",
  });
  assert.deepEqual(reduceUpdateEvent(initialUpdateStatus, { type: "current" }), { state: "current" });
  assert.deepEqual(reduceUpdateEvent(initialUpdateStatus, { type: "error", message: "network failed" }), {
    state: "error",
    message: "network failed",
  });
});
