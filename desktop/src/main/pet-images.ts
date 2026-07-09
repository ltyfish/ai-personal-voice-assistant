import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import type { PetImageOverrides, PetVisualState } from "../shared/types.js";

export const PET_IMAGE_ENV_KEYS: Record<PetVisualState, string> = {
  idle: "JARVIS_PET_IDLE_IMAGE",
  dragging: "JARVIS_PET_DRAGGING_IMAGE",
  listening: "JARVIS_PET_LISTENING_IMAGE",
  thinking: "JARVIS_PET_THINKING_IMAGE",
  approval: "JARVIS_PET_APPROVAL_IMAGE",
  denied: "JARVIS_PET_DENIED_IMAGE",
  approved: "JARVIS_PET_APPROVED_IMAGE",
  talking: "JARVIS_PET_TALKING_IMAGE",
};

export function parsePetImageEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const sourceLine of contents.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) values[key] = value;
  }
  return values;
}

function resolveImage(value: string): string | undefined {
  if (/^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  }
  if (!isAbsolute(value) || !existsSync(value)) return undefined;
  return pathToFileURL(value).toString();
}

export function loadPetImages(
  envFilePath: string,
  processValues: NodeJS.ProcessEnv = process.env,
): PetImageOverrides {
  const fileValues = existsSync(envFilePath)
    ? parsePetImageEnv(readFileSync(envFilePath, "utf8"))
    : {};
  const images: PetImageOverrides = {};
  for (const [state, key] of Object.entries(PET_IMAGE_ENV_KEYS) as [PetVisualState, string][]) {
    const value = processValues[key]?.trim() || fileValues[key];
    const resolved = value ? resolveImage(value) : undefined;
    if (resolved) images[state] = resolved;
  }
  return images;
}
