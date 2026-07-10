"use client";

import { useState } from "react";

const INSTALLER_URL =
  "https://github.com/ltyfish/ai-personal-voice-assistant/releases/latest/download/JARVIS-Desktop-Setup.exe";

export default function DesktopPetDownload() {
  const [visible, setVisible] = useState(true);
  if (!visible) return null;
  return (
    <aside className="desktop-pet-download">
      <button type="button" className="desktop-pet-close" onClick={() => setVisible(false)} aria-label="Dismiss desktop pet download">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5 5 15" /></svg>
      </button>
      <div>
        <strong>JARVIS on your desktop</strong>
        <span>Install the floating Windows pet. It stays connected to this cloud JARVIS.</span>
      </div>
      <a href={INSTALLER_URL}>Download JARVIS Pet for Windows</a>
    </aside>
  );
}
