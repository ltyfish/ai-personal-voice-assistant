import type { MailConfig } from "./types";

export function applyVipBoost(
  urgency: number,
  fromEmail: string,
  vipSenders: MailConfig["vipSenders"]
) {
  const isVip = vipSenders.some(
    (v) => v.email.toLowerCase() === fromEmail.toLowerCase()
  );
  return isVip ? clampUrgency(urgency + 1) : urgency;
}

export function clampUrgency(n: number) {
  return Math.min(5, Math.max(1, n));
}

export function urgencyLabel(score: number) {
  return ["", "Minimal", "Low", "Medium", "High", "Critical"][score] ?? "Unknown";
}

export function urgencyColor(score: number) {
  return (
    ["", "#94a3b8", "#60a5fa", "#facc15", "#f97316", "#ef4444"][score] ?? "#94a3b8"
  );
}
