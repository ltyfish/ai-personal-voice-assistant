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
  await writeFile(
    envFile,
    [
      `JARVIS_PET_IDLE_IMAGE=${idle}`,
      "JARVIS_PET_LISTENING_IMAGE=https://example.com/listening.png",
      "JARVIS_PET_THINKING_IMAGE=relative.png",
    ].join("\n"),
  );

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
