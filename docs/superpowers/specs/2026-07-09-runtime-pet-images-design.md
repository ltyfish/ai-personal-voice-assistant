# Runtime Pet Images Design

## Goal

Allow every JARVIS Desktop character state to use a user-selected image without changing source code or rebuilding the application. Images may be absolute local file paths or HTTP(S) URLs. Saving the runtime environment file updates the running pet.

## Configuration

The packaged application reads `jarvis-pet.env` from the directory containing `JARVIS Desktop.exe`. Development reads the same filename from the repository root. Process environment variables override values from the file.

Supported variables:

```env
JARVIS_PET_IDLE_IMAGE=C:\Pets\idle.png
JARVIS_PET_DRAGGING_IMAGE=C:\Pets\dragging.png
JARVIS_PET_LISTENING_IMAGE=C:\Pets\listening.png
JARVIS_PET_THINKING_IMAGE=C:\Pets\thinking.png
JARVIS_PET_APPROVAL_IMAGE=C:\Pets\approval.png
JARVIS_PET_DENIED_IMAGE=C:\Pets\denied.png
JARVIS_PET_APPROVED_IMAGE=C:\Pets\approved.png
JARVIS_PET_TALKING_IMAGE=C:\Pets\talking.png
```

Whitespace surrounding keys and values is ignored. Blank values are treated as unset. Values may optionally be wrapped in matching single or double quotes.

## Image Resolution

The Electron main process owns runtime configuration:

- Absolute local paths are checked for existence and converted to `file://` URLs.
- `http://` and `https://` values are passed through unchanged.
- Relative paths, unsupported schemes, and missing files are rejected.
- Rejected or unset values are omitted so the renderer uses its bundled image for that state.
- Configuration errors are written to the existing desktop log and do not interrupt startup.

The main process exposes the resolved image map through preload IPC. It watches `jarvis-pet.env` and sends a changed event after a short debounce whenever the file is created, modified, renamed, or deleted. The renderer replaces its image map without restarting or rebuilding.

## State Model

The renderer selects one visual state at a time:

| State | Trigger | Duration |
| --- | --- | --- |
| `idle` | No higher-priority activity | Until another state begins |
| `dragging` | Pointer movement passes the drag threshold | Until pointer up or cancellation |
| `listening` | Wake activation or manual listening starts | Until recording stops |
| `thinking` | A text/audio request is waiting for a response | Until a result or error arrives |
| `approval` | A local action requires confirmation | Until Continue or Stop |
| `denied` | Stop is pressed on a pending approval | Brief transition, then idle |
| `approved` | Continue is pressed | While the approved local action runs |
| `talking` | JARVIS speaks the completed response | Until speech ends |

Interaction states take precedence over ordinary activity. Dragging is highest priority while the pointer is actively moving. Approval remains visible while confirmation is pending. Approved and denied are explicit states rather than being inferred from reply text.

If voice output is disabled, a successful ordinary response returns to idle. A successful approved action displays `approved` while running, then returns to idle instead of displaying `talking`.

## Components

### Runtime Image Loader

A small main-process module parses the environment file, merges process overrides, validates values, resolves local paths, and returns a typed image map. Its parsing and resolution logic is independent from Electron so it can be tested directly.

### IPC Contract

Shared types define the eight image state keys and a partial map of resolved URLs. Preload exposes:

- `getPetImages()` for initial renderer state.
- `onPetImagesChanged(listener)` for hot updates, returning an unsubscribe function.

### Renderer State

The renderer keeps the resolved override map in React state and merges it over bundled defaults. A dedicated visual-state value handles `dragging`, `approved`, and `denied` transitions without changing persistent pet mode.

### Example File

The repository includes `jarvis-pet.env.example` with all supported keys and comments. The local update script preserves a user's existing `jarvis-pet.env` in the installed application directory.

## Error Handling

- A broken local path affects only its own state.
- A remote image that fails in the renderer falls back to the bundled image through the image element error handler.
- File watcher errors are logged; startup and existing images continue to work.
- Deleting the environment file restores all bundled defaults.

## Testing

Unit-level checks cover parsing, precedence, URL validation, local path conversion, and fallback omission. Existing Electron contract checks are extended for the IPC methods and all eight state variables. Type checking and renderer/main production builds verify integration.

Manual verification changes an idle image path while the packaged app is open, confirms immediate replacement, then exercises drag, listen, think, approval, deny, approve, and talking transitions.
