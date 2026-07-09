import assert from "node:assert/strict";
import { selectSttModel } from "../lib/stt-model.ts";

assert.equal(selectSttModel("fast"), "whisper-large-v3-turbo");
assert.equal(selectSttModel("default"), "whisper-large-v3");
assert.equal(selectSttModel("unexpected"), "whisper-large-v3");

console.log("STT model selection check passed.");
