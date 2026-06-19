import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const voicePath = path.join(root, "components", "VoiceButton.tsx");
const wakePath = path.join(root, "lib", "wakeword.ts");

const voice = fs.readFileSync(voicePath, "utf8");
const wake = fs.readFileSync(wakePath, "utf8");

const alwaysListenPatterns = [
  /Auto-start wake-word listening on load/,
  /void startListening\(\);\s*const onGesture/,
  /else\s*{\s*void startListening\(\);\s*}\s*void acquireWakeLock\(\);/,
];

for (const pattern of alwaysListenPatterns) {
  if (!pattern.test(voice)) {
    throw new Error(`VoiceButton must keep always-listening startup: ${pattern}`);
  }
}

for (const flag of ["echoCancellation", "noiseSuppression", "autoGainControl"]) {
  const pattern = new RegExp(`${flag}:\\s*false`);
  if (!pattern.test(wake)) {
    throw new Error(`Wake-word mic stream must keep ${flag}=false`);
  }
}

for (const flag of ["echoCancellation", "noiseSuppression", "autoGainControl"]) {
  const enabledPattern = new RegExp(`${flag}:\\s*true`);
  if (enabledPattern.test(voice)) {
    throw new Error(`Command capture must not enable ${flag}`);
  }
}

console.log("voice stays always-on and all browser mic capture stays raw");
