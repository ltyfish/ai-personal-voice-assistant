import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_CAPTURE_MS,
  MIN_CAPTURE_MS,
  SILENCE_STOP_MS,
  shouldStopForSilence,
} from "../dist/shared/voice-capture.js";

test("does not stop before the minimum capture duration", () => {
  assert.equal(
    shouldStopForSilence({
      elapsedMs: MIN_CAPTURE_MS - 1,
      speechObserved: true,
      silentForMs: SILENCE_STOP_MS,
    }),
    false,
  );
});

test("does not stop until speech has been observed", () => {
  assert.equal(
    shouldStopForSilence({
      elapsedMs: MIN_CAPTURE_MS + 500,
      speechObserved: false,
      silentForMs: SILENCE_STOP_MS,
    }),
    false,
  );
});

test("does not stop before sustained silence reaches the threshold", () => {
  assert.equal(
    shouldStopForSilence({
      elapsedMs: MIN_CAPTURE_MS + 500,
      speechObserved: true,
      silentForMs: SILENCE_STOP_MS - 1,
    }),
    false,
  );
});

test("stops after speech followed by sustained silence", () => {
  assert.equal(
    shouldStopForSilence({
      elapsedMs: MIN_CAPTURE_MS + 500,
      speechObserved: true,
      silentForMs: SILENCE_STOP_MS,
    }),
    true,
  );
});

test("always stops at the maximum capture duration", () => {
  assert.equal(
    shouldStopForSilence({
      elapsedMs: MAX_CAPTURE_MS,
      speechObserved: false,
      silentForMs: 0,
    }),
    true,
  );
});
