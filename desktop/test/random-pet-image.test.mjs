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
