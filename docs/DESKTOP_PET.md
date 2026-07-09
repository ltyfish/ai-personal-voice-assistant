# Desktop Pet and Updates

## Installation

Download and run the latest installer:

https://github.com/ltyfish/ai-personal-voice-assistant/releases/latest/download/JARVIS-Desktop-Setup.exe

Installing a newer version replaces the previous application while preserving Electron user-data
settings. Close the running pet first if Windows does not close it automatically.

## Architecture

JARVIS Desktop is a floating Electron client for the cloud-hosted JARVIS website. Wake-word detection,
microphone capture, text-to-speech, window movement, and approved local actions run on the laptop.
Assistant turns use the deployed `/api/voice` endpoint, shared cloud model rotation, and shared data.

The **Open JARVIS** action launches the configured production website in the default browser.

Electron uses multiple operating-system processes for its main process, renderer, GPU, audio, and
utility services. Several `JARVIS Desktop` entries in Task Manager are normal. Multiple visible pet
windows are not.

## Pet Image Stages

Release installers package the PNG files in `/Images` and classify them by filename:

| Filename marker | Stage |
| --- | --- |
| `Idle` | Waiting |
| `Dragged` | Window dragging |
| `Listening` | Capturing speech |
| `Thinking` | Waiting for the assistant |
| `Approval` | Local action awaiting confirmation |
| `Approved` | Confirmed action |
| `Denied` | Rejected action |
| `Talking` | Speaking the reply |

Each stage currently has three images. Selection rotates randomly without immediately repeating when
alternatives exist.

An optional `jarvis-pet.env` beside the executable can override packaged images using absolute paths
or HTTP(S) URLs. Runtime overrides take precedence over packaged stage pools.

## Interaction

- Click the pet to open or close its prompt.
- Drag the pet to move its transparent window.
- Use **Listen** for immediate microphone capture.
- Use **Open JARVIS** for the full website.
- Use **Sleep** to reduce the pet.
- Local computer actions require confirmation.

Voice capture stops after speech followed by sustained silence, with a maximum recording duration as
a fallback. Desktop transcription uses the faster Whisper turbo model. Timing diagnostics are written
to Electron's `desktop.log` without audio or transcript contents.

## Automatic Updates

Every successful push to `main` runs `.github/workflows/release-desktop.yml`. The workflow:

1. Installs locked web and desktop dependencies.
2. Runs desktop tests, typecheck, and wiring checks.
3. Builds the web runtime used by the packaged application.
4. Generates version `0.1.<GitHub run number>`.
5. Builds the NSIS installer.
6. Publishes the installer, blockmap, and `latest.yml` to GitHub Releases.

Packaged pets check for a newer release shortly after startup and every six hours. Updates download in
the background, but installation occurs only after **Restart and update** is clicked. The tray menu
also provides **Check for updates**.

Windows can display an unknown-publisher warning because the installer is not currently code-signed.

## Development

Run the pet in development:

```powershell
npm run desktop:dev
```

Run checks:

```powershell
npm --prefix desktop test
npm --prefix desktop run typecheck
node scripts/check-desktop-electron.mjs
node scripts/check-desktop-release-config.mjs
```

Build the Windows installer:

```powershell
npm run build
npm run desktop:build
```

The installer is written to `desktop/release/JARVIS-Desktop-Setup.exe`.

## Troubleshooting

- **Old images or missing controls:** install the newest release; Vercel deployment does not update an
  already installed Electron binary.
- **Pet fails at startup:** inspect `%APPDATA%\jarvis-desktop\desktop.log`.
- **Several Task Manager processes:** expected Electron subprocesses.
- **Several visible pets:** close all instances and relaunch; the application enforces a single-instance lock.
- **Update failed:** use the tray's manual check or download the latest installer from the stable URL.
