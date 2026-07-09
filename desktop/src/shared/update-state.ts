export type DesktopUpdateStatus =
  | { state: "idle" | "checking" | "current" }
  | { state: "available" | "ready"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "error"; message: string };

export type DesktopUpdateEvent =
  | { type: "checking" | "current" }
  | { type: "available" | "downloaded"; version: string }
  | { type: "progress"; percent: number }
  | { type: "error"; message: string };

export const initialUpdateStatus: DesktopUpdateStatus = { state: "idle" };

export function reduceUpdateEvent(
  _current: DesktopUpdateStatus,
  event: DesktopUpdateEvent,
): DesktopUpdateStatus {
  switch (event.type) {
    case "checking":
      return { state: "checking" };
    case "current":
      return { state: "current" };
    case "available":
      return { state: "available", version: event.version };
    case "downloaded":
      return { state: "ready", version: event.version };
    case "progress":
      return { state: "downloading", percent: Math.max(0, Math.min(100, Math.round(event.percent))) };
    case "error":
      return { state: "error", message: event.message };
  }
}
