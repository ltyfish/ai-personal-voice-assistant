const INSTALLER_URL =
  "https://github.com/ltyfish/ai-personal-voice-assistant/releases/latest/download/JARVIS-Desktop-Setup.exe";

export default function DesktopPetDownload() {
  return (
    <aside className="desktop-pet-download">
      <div>
        <strong>JARVIS on your desktop</strong>
        <span>Install the floating Windows pet. It stays connected to this cloud JARVIS.</span>
      </div>
      <a href={INSTALLER_URL}>Download JARVIS Pet for Windows</a>
    </aside>
  );
}
