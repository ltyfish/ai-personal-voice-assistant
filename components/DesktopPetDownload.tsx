const INSTALLER_URL =
  "https://github.com/ltyfish/ai-personal-voice-assistant/releases/latest/download/JARVIS-Desktop-Setup.exe";

export default function DesktopPetDownload() {
  return (
    <aside className="desktop-pet-download" data-cursor="PET">
      <div className="pet-portrait" aria-hidden>
        <img src="/media/sawako-pet.png" alt="" />
        <span className="pet-signal" />
      </div>
      <div className="pet-copy">
        <strong>JARVIS on your desktop</strong>
        <span>Install the floating Windows pet. It stays connected to this cloud JARVIS.</span>
      </div>
      <a href={INSTALLER_URL} data-cursor="INSTALL">Download JARVIS Pet for Windows</a>
    </aside>
  );
}
