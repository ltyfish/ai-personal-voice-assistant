import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyPetImageName,
  loadPetImages,
  parsePetImageEnv,
  parsePetImageList,
} from "../dist/main/pet-images.js";

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

test("loads local files and URLs while process variables take precedence", async (t) => {
  const dir = join(tmpdir(), `jarvis-pet-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const idle = join(dir, "idle.png");
  const idleTwo = join(dir, "idle-two.png");
  await writeFile(idle, "image");
  await writeFile(idleTwo, "image");
  const envFile = join(dir, "jarvis-pet.env");
  await writeFile(
    envFile,
    [
      `JARVIS_PET_IDLE_IMAGE=${idle}, ${idleTwo}, missing.png`,
      "JARVIS_PET_LISTENING_IMAGE=https://example.com/listening.png, https://example.com/listening-2.png",
      "JARVIS_PET_THINKING_IMAGE=relative.png",
    ].join("\n"),
  );

  const result = loadPetImages(envFile, {
    JARVIS_PET_LISTENING_IMAGE: "https://cdn.example.com/listening.png, https://cdn.example.com/listening-2.png",
  });

  assert.equal(result.idle.length, 2);
  assert.ok(result.idle.every((image) => image.startsWith("file://")));
  assert.deepEqual(result.listening, [
    "https://cdn.example.com/listening.png",
    "https://cdn.example.com/listening-2.png",
  ]);
  assert.equal(result.thinking, undefined);
});

test("returns no overrides when the environment file is missing", () => {
  assert.deepEqual(loadPetImages("Z:\\missing\\jarvis-pet.env", {}), {});
});

test("classifies image filenames into their intended visual states", () => {
  assert.equal(classifyPetImageName("Sawako Idle V1.png"), "idle");
  assert.equal(classifyPetImageName("Sawako Dragged V2.png"), "dragging");
  assert.equal(classifyPetImageName("Sawako Listening V3.png"), "listening");
  assert.equal(classifyPetImageName("Kazehaya Thinking V2.png"), "thinking");
  assert.equal(classifyPetImageName("Ayane Approval V2.png"), "approval");
  assert.equal(classifyPetImageName("Ume Denied V3.png"), "denied");
  assert.equal(classifyPetImageName("Sawako Approved V3.png"), "approved");
  assert.equal(classifyPetImageName("Sawako Talking V1.png"), "talking");
});
