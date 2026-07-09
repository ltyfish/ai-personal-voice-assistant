# Random Pet Image Pools Design

## Goal

Allow every JARVIS Desktop visual state to contain multiple configured images. The pet chooses a random image when entering a state, avoids immediate repeats, and rotates its idle image every five minutes.

## Environment Format

The existing eight environment variables accept comma-separated absolute local paths and HTTP(S) URLs:

```env
JARVIS_PET_IDLE_IMAGE=C:\Pets\idle-1.png, C:\Pets\idle-2.png, https://example.com/idle-3.png
JARVIS_PET_DRAGGING_IMAGE=C:\Pets\drag-1.png, C:\Pets\drag-2.png
JARVIS_PET_LISTENING_IMAGE=C:\Pets\listen-1.png, C:\Pets\listen-2.png
JARVIS_PET_THINKING_IMAGE=C:\Pets\think-1.png, C:\Pets\think-2.png
JARVIS_PET_APPROVAL_IMAGE=C:\Pets\ask-1.png, C:\Pets\ask-2.png
JARVIS_PET_DENIED_IMAGE=C:\Pets\no-1.png, C:\Pets\no-2.png
JARVIS_PET_APPROVED_IMAGE=C:\Pets\yes-1.png, C:\Pets\yes-2.png
JARVIS_PET_TALKING_IMAGE=C:\Pets\talk-1.png, C:\Pets\talk-2.png
```

Whitespace around each item is ignored. Each item may be wrapped in matching single or double quotes. Empty items are discarded. A comma is always a separator; local filenames containing commas must be renamed, and commas inside URLs must be percent-encoded.

The main process validates every item independently:

- Existing absolute local paths become `file://` URLs.
- Valid `http://` and `https://` URLs remain remote URLs.
- Relative paths, missing local files, unsupported schemes, and malformed URLs are omitted.
- Process environment values continue to override the corresponding file value as a complete list.

The IPC image map changes from one optional URL per state to one optional URL array per state. A state with no valid override entries uses its bundled image.

## Selection Behavior

A pure selection helper receives an image pool, the previously displayed image, and a random-number source. It returns:

- The only image when the pool has one entry.
- A random image other than the previous image when the pool has multiple entries.
- The bundled fallback when no configured image remains usable.

Immediate repeats are prevented per state. Each state remembers its own last selected image, so entering thinking does not erase idle's history.

The renderer chooses a new image:

- When the visual state changes.
- When the same event state begins again after leaving it.
- Immediately after a hot-reloaded image map changes.
- Every five minutes while the current state remains idle.

The five-minute timer runs only while idle. Leaving idle clears the timer. Returning to idle selects an image immediately and starts a fresh five-minute interval.

The renderer does not reroll on ordinary React renders.

## Failed Remote Images

Local files are validated before reaching the renderer, but a remote URL can fail later. When the active image emits an error:

1. The failed URL is excluded from the current state's available pool.
2. Another configured image is selected without repeating the failed image.
3. If no configured candidates remain, the bundled image is displayed.
4. Hot reloading the environment file clears the failed-URL exclusions.

Failures in one state do not affect another state.

## Components

### Main-Process Loader

`desktop/src/main/pet-images.ts` parses each configured value into a list and resolves every item. Its output is a `PetImagePools` map of visual states to URL arrays.

### Random Selector

A pure shared helper selects from a pool while excluding a previous or failed image. Dependency injection for the random-number function makes boundary cases deterministic in tests.

### Renderer

The renderer stores:

- The latest configured image pools.
- The currently selected image.
- The last selected image for each state.
- Remote URLs that failed since the last configuration reload.

Effects respond only to visual-state changes, configuration changes, and the idle interval. Existing visual-state priority remains unchanged.

## Hot Reload

Saving `jarvis-pet.env` continues to trigger the main-process watcher. The renderer replaces all pools, clears failed URL exclusions, and immediately selects a new image for the active state. The application does not restart or rebuild.

## Testing

Loader tests cover comma splitting, trimming, optional item quotes, mixed local/remote pools, invalid-item omission, and process-value precedence.

Selector tests cover:

- Single-item pools.
- Deterministic random choice.
- Immediate-repeat prevention.
- Fallback when all candidates are excluded.

Renderer contract checks require state-change selection, per-state history, hot-reload rerolling, failed-image exclusion, and a 300,000 millisecond idle interval. Full type checking and production builds verify integration.
