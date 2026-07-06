# Windows JARVIS Desktop Pet Design

## Goal

Build a separate Windows downloadable JARVIS app while leaving the existing website unchanged. The app should feel like a desktop JARVIS companion: a draggable orb/pet that can start on login, listen for "Jarvis", accept typed prompts, speak replies, and sleep or shrink when the user does not want it covering the screen.

The desktop app should bundle or launch a local copy of the JARVIS UI/backend for the Windows app, while still using the same assistant behavior, cloud model router, data APIs, and Neon-backed state as the current web app. It should not fork the task/calendar/notes/projects/mail/model database or duplicate model-rotation logic.

## Product Scope

The Windows app is a copy of the JARVIS experience packaged for desktop, not a replacement for the website. The first desktop version targets Windows only and ships as an installable `.exe`.

Core user-facing behavior:

- Launch at Windows login when enabled.
- Show a draggable JARVIS orb that can sit above other windows.
- Wake locally on "Jarvis" and capture a spoken command.
- Let the user type a prompt when they do not want to talk.
- Speak assistant replies through local TTS.
- Sleep or compact into a small non-intrusive state.
- Provide tray controls for wake/sleep, open full JARVIS, restart local bridge, and quit.
- Use the same cloud/API/database data as the website.

Out of scope for the first implementation:

- macOS/Linux packaging.
- A separate local-first database or offline sync queue.
- Rewriting the existing web dashboard UI from scratch.
- Replacing the deployed website.
- Reimplementing the model router inside the desktop app.

## Recommended Approach

Use Electron for the Windows app.

Electron is the best fit for this codebase because the existing app is Next.js/React, and the desktop app needs native shell behavior: transparent windows, tray menu, startup registration, child-process management, and Windows-specific desktop integration. Tauri would produce a smaller binary, but it would add more custom integration work before the product behavior is proven. A separate native app would duplicate too much UI and assistant behavior.

The Electron app should run a managed local JARVIS runtime for the desktop copy. That runtime can be a bundled local Next server plus a desktop renderer, with production configuration pointing at the same Neon database and cloud model providers used by the website. The deployed website remains independent.

## Architecture

```text
Windows .exe
  -> Electron main process
      -> app lifecycle
      -> tray/startup
      -> native window management
      -> managed local JARVIS runtime
      -> local bridge process manager
      -> safe IPC boundary
  -> Electron renderer
      -> draggable JARVIS orb/pet
      -> prompt panel
      -> status/sleep UI
      -> TTS playback
  -> local JARVIS backend copy or configured cloud API
      -> same Neon database
      -> same /api/v1 model router
      -> same tools and MailMind/task/calendar data
```

The website remains deployed and usable as it is. The desktop app uses the same backend route shapes and same data source. The preferred long-term desktop runtime is a local bundled backend copy managed by Electron; a cloud API URL can remain available as a fallback or configuration option. For desktop-local actions, the Electron main process manages the local bridge code as a child process or wraps the existing bridge startup flow.

## Components

### Electron Main Process

Responsibilities:

- Create and manage the pet window.
- Create tray menu and app lifecycle actions.
- Register/unregister Windows startup.
- Launch, monitor, and restart the local bridge.
- Expose safe IPC APIs to the renderer.
- Store local runtime preferences such as orb position, sleep mode, voice settings, wake listener setting, local runtime URL/cloud fallback URL, and startup setting.

The main process should not contain assistant reasoning or model-routing logic. It delegates assistant turns to the managed local JARVIS backend or the configured cloud API.

### Pet Window

A frameless transparent Electron window containing the JARVIS orb. It should be draggable and support these states:

- `sleeping`: minimal footprint, no wake listening unless explicitly configured.
- `idle`: visible, ready, unobtrusive.
- `listening`: wake word or active capture.
- `thinking`: request in flight.
- `speaking`: TTS output active.
- `error/offline`: backend or bridge problem.

The window should remember its position and have bounds checks so it cannot get stranded off-screen.

### Prompt Panel

The prompt panel opens from clicking the orb, a tray action, or a hotkey. It provides:

- Typed prompt input.
- Current status.
- Last transcript and reply.
- Stop speaking.
- Sleep/compact button.

Typed prompts should follow the same assistant path as web typed/voice input wherever possible.

### Wake Listener

The Windows app should run a local wake-word listener for "Jarvis". After wake:

1. Record the user command.
2. Send audio through the existing transcription/agent path where possible.
3. Route the turn through local or cloud behavior using the same rules as the current app.
4. Speak the reply.

If microphone permission or wake detection fails, typed prompt remains available.

### Bridge Manager

The desktop app should reuse the existing local bridge behavior rather than rewrite desktop automation. It should:

- Start the bridge when the app starts.
- Detect bridge health.
- Restart bridge from tray/settings.
- Surface bridge status in the pet UI.
- Preserve existing safety gates for shell/local actions.

## Data Flow

Typed prompt:

```text
User types prompt
  -> pet renderer
  -> Electron IPC
  -> managed local JARVIS API or configured cloud API
  -> same model router/tools/database
  -> reply
  -> pet renderer displays reply and speaks it
```

Voice prompt:

```text
Wake listener hears "Jarvis"
  -> record command audio
  -> transcription/agent API
  -> same model router/tools/database
  -> reply
  -> TTS output
```

Desktop action:

```text
Assistant requests local action
  -> confirmation when required
  -> bridge manager / bridge process
  -> action result
  -> assistant/UI
```

Shared cloud data:

```text
Tasks, calendar, notes, projects, MailMind, LLM keys, activity, router state
  -> existing APIs
  -> existing Neon database
```

## Local Storage

The desktop app stores only runtime/client preferences locally:

- Orb position and size/compact state.
- Startup enabled.
- Wake listener enabled.
- Voice/TTS preference.
- Local runtime URL and optional cloud fallback URL.
- Bridge token or local bridge config.
- Last non-sensitive status values.

Cloud data stays in the existing database through existing APIs. API keys and router state remain server-side.

## Error Handling

- Backend offline: show offline state, keep prompt available, retry in background.
- Bridge offline: assistant chat still works; desktop actions show unavailable.
- Microphone unavailable: disable wake/voice capture and keep typed prompt available.
- TTS unavailable: display replies and show a voice-output warning.
- Router/model failure: surface the existing error and keep the pet alive.
- Bridge crash: restart once automatically, then show restart action.
- App starts before network: open in idle/offline state and reconnect quietly.

## Security

- Do not expose `.env` values or model/API keys to the renderer.
- Use Electron context isolation and a narrow preload IPC API.
- Keep shell/local action safety checks in the bridge.
- Require confirmation for destructive or opaque local actions.
- Store local tokens/config in Windows app data or Windows Credential Manager when available.
- Treat bridge/relay secrets as machine-control secrets.

## Packaging

Target: Windows `.exe` installer.

Likely package stack:

- `electron`
- `electron-builder`
- `electron-store` or a small local config file for preferences
- existing Next/React code reused in the renderer where practical

The app should support:

- Start menu shortcut.
- Optional startup-on-login.
- Tray icon.
- Uninstall cleanup for startup entry.

## Implementation Phases

### Phase 1: Desktop Shell

- Add Electron app scaffold under `desktop/`.
- Create tray and frameless draggable orb window.
- Store window position and sleep state.
- Add basic prompt panel with mocked/no-op assistant call.

### Phase 2: Assistant Wiring

- Connect typed prompt to existing assistant/API path.
- Speak replies via desktop TTS.
- Show model/bridge/backend status.
- Add stop-speaking and retry behavior.

### Phase 3: Bridge and Startup

- Manage bridge as child process or controlled companion.
- Add startup registration.
- Add tray actions for wake/sleep/open/restart/quit.
- Surface bridge errors clearly.

### Phase 4: Wake Listener

- Add local "Jarvis" wake listener.
- Record command after wake.
- Route audio through existing transcription/assistant flow.
- Ensure typed prompt remains the fallback.

### Phase 5: Packaging and Verification

- Produce Windows installer.
- Test install, login startup, wake word, typed prompt, TTS, sleep, tray, bridge restart, and uninstall.

## Testing Plan

Automated checks:

- TypeScript compile for shared code and desktop TypeScript.
- Static check that Electron IPC exposes only intended methods.
- Basic unit checks for local preference load/save.
- Existing app checks remain unchanged.

Manual Windows checks:

- Install `.exe`.
- Launch from Start menu.
- Enable startup and verify after login.
- Drag orb and restart app; position persists.
- Put orb to sleep and wake it.
- Type prompt and hear spoken reply.
- Say "Jarvis" and complete a voice turn.
- Confirm bridge status and restart bridge from tray.
- Trigger a desktop action that requires confirmation.
- Quit from tray.

## Open Questions For Implementation

- Exact packaging shape for the managed local Next runtime.
- Exact wake-word engine choice for Windows.
- Whether to reuse browser Web Speech/Piper TTS first or use a native Windows TTS bridge.
- How much of the current `VoiceButton` logic should be shared versus reimplemented as desktop-specific hooks.
