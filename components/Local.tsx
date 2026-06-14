"use client";

// The "Local" tab — only mounted when the local computer (bridge) is online.
// Two views: NORMAL (local-only status; the AI-mode + model pickers live on the
// JARVIS deck) and CODING (autonomous coding projects, each assigned a local model
// + its own memory). The toggle preference is remembered per device.

import type { LocalStatus } from "@/lib/local-presence";
import Pipeline from "./Pipeline";

export default function Local({ status }: { status: LocalStatus }) {
  return (
    <div className="modern-tab local-tab">
      <header className="tab-head">
        <h1>Local</h1>
        <p className="tab-sub">
          <span
            style={{
              display: "inline-block", width: 8, height: 8, borderRadius: "50%",
              marginRight: 7, verticalAlign: "middle",
              background: status.bridge ? "#fff" : "#444",
              boxShadow: status.bridge ? "0 0 8px rgba(255,255,255,.5)" : "none",
            }}
          />
          Bridge {status.bridge ? "online" : "offline"} · coding pipelines
        </p>
      </header>

      <Pipeline status={status} />
    </div>
  );
}
