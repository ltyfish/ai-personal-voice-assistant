// Tiny global pub/sub for the JARVIS orb state so the persistent mini-orb (shown
// on every non-JARVIS tab) can mirror the live voice state owned by VoiceButton.
import type { OrbState } from "@/components/jarvis/SwirlOrb";

let current: OrbState = "st-standby";
const subs = new Set<(s: OrbState) => void>();

export function publishOrbState(s: OrbState) {
  if (s === current) return;
  current = s;
  subs.forEach((f) => f(s));
}
export function getOrbState(): OrbState {
  return current;
}
export function subscribeOrbState(f: (s: OrbState) => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}
