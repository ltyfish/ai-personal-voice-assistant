# Pet Web Launch and Voice Latency Design

## Goal

Make the desktop pet a lightweight cloud-connected JARVIS client: users can open the full production website directly from the pet, and spoken commands stop recording promptly after speech ends instead of always waiting for the fixed capture timeout.

## Scope

- Add a visible **Open JARVIS** button to the pet prompt dock.
- Open the configured cloud JARVIS URL through Electron's existing `desktop:openFullJarvis` IPC handler.
- End voice capture after a short period of detected silence, while retaining the current maximum recording duration as a safety limit.
- Use Groq's faster Whisper turbo transcription model for desktop audio turns only.
- Record stage timings for desktop voice turns so remaining latency can be identified from logs.
- Preserve cloud model rotation, shared website state, wake-word listening, local bridge actions, and approval prompts.

## Architecture

### Web launch

The renderer button calls `window.jarvisDesktop.openFullJarvis()`. The preload bridge forwards that request to the existing Electron main-process IPC handler. The main process calls `shell.openExternal` with the normalized configured backend URL, which defaults to the deployed Vercel website.

No URL is accepted from renderer input. This preserves the existing trust boundary and prevents arbitrary renderer-controlled external navigation.

### Voice capture

After wake-word detection or manual listening:

1. Start `MediaRecorder` as today.
2. Observe microphone amplitude through a Web Audio analyser.
3. Ignore silence termination during a short minimum capture window.
4. Once speech has been observed, stop after approximately 800 ms of sustained silence.
5. Keep 5.2 seconds as the hard maximum.
6. Clean up analyser nodes, animation callbacks, recorder state, and temporary microphone streams on every completion and error path.

If Web Audio analysis is unavailable, recording falls back to the current fixed maximum. This keeps voice capture functional on constrained Electron environments.

### Transcription routing

Desktop multipart requests include a transcription-speed preference. The voice API validates that preference and selects `whisper-large-v3-turbo` only for the desktop fast path. Existing web voice requests retain the current accuracy-focused `whisper-large-v3` default.

### Timing diagnostics

The desktop client records capture duration and request duration. The voice API records transcription and agent durations and returns them as optional diagnostic metadata. Electron writes a compact timing line to its existing desktop log. Timing data must not include transcript or audio contents.

## Error Handling

- Failure to open the browser is surfaced in the pet reply instead of being silently ignored.
- Silence detection failure falls back to the hard timeout.
- Empty or near-empty clips continue to return the existing “I didn't catch that” response.
- Unknown transcription preferences are ignored and use the default STT model.
- Network and model errors continue through the current error handling and timeout behavior.

## Testing

- Unit-test the silence-stop decision as a pure state transition independent of browser APIs.
- Verify silence cannot stop capture before speech is observed or before the minimum duration.
- Verify sustained silence after speech stops capture.
- Verify the maximum duration always stops capture.
- Verify desktop requests select turbo STT while ordinary web requests retain the default.
- Extend the desktop wiring check to cover the visible button and existing IPC call.
- Run desktop tests, desktop typecheck, the web test/check scripts relevant to changed files, and the production web build.

## Deployment

Commit only intended files, push the completed branch to `main`, and verify that the resulting Vercel production deployment reaches a successful ready state. Existing unrelated working-tree changes are excluded.
