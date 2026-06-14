// Where should ONE voice turn run? This is the pure decision that the browser
// makes per turn, given what local backends are up.
//
// It lives in its own module (no server-only or "use client" imports) so the
// client can import it freely — lib/agent.ts can't be imported in the browser
// because it pulls in the DB. The actual DISPATCH (cloud → /api/voice, local →
// bridge /local/chat) happens in the browser, since only the browser can reach
// the localhost bridge.

import type { ModelMode } from "./local-mode";
import type { LocalStatus } from "./local-presence";

export type TurnBackend = "cloud" | "local";

// Decide the backend for a turn. The only switch now is presence:
//   • bridge online  → run JARVIS's local tool loop on the user's machine.
//   • bridge offline → cloud is all we have.
export function decideTurnRoute(
  _mode: ModelMode,
  _text: string,
  presence: LocalStatus
): TurnBackend {
  if (!presence.bridge) return "cloud";
  return "local";
}
