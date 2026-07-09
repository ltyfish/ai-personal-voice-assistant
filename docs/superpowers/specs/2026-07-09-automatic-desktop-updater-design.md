# Automatic Desktop Updater Design

## Goal

Deliver every successful `main` branch desktop build through GitHub Releases, let users install the floating JARVIS Pet from the JARVIS website, and let packaged installations notify the user, download the update, and install it only after the user clicks **Restart and update**.

## Website Installation Entry Point

The JARVIS website exposes a visible **Download JARVIS Pet for Windows** action. It links to a stable repository release URL that resolves to the newest Windows installer rather than embedding a version-specific filename in the web bundle.

The download action:

- Identifies the artifact as a Windows desktop companion.
- Explains that the pet remains connected to the cloud-hosted JARVIS website and shared data.
- Opens the GitHub-hosted installer download without proxying the executable through Vercel.
- Remains useful before the first updater-enabled release by showing a clear unavailable state if no release artifact has been published yet.

Installing the downloaded executable creates the same transparent, always-on-top floating pet. The website remains the full interface; the pet is a lightweight voice/text entry point and local-action bridge.

## Release Architecture

A GitHub Actions workflow runs on every push to `main`. It:

1. Checks out the pushed commit.
2. Installs root and desktop dependencies from lockfiles.
3. Runs desktop tests, desktop typecheck, Electron wiring checks, and the web production build.
4. Generates a monotonically increasing desktop version using the GitHub run number, formatted as `0.1.<run_number>`.
5. Builds the Windows NSIS installer with Electron Builder.
6. Publishes a GitHub Release containing the installer, blockmap, and `latest.yml` update manifest.

The release tag and title use the generated desktop version. Each successful `main` build therefore becomes a newer stable update. Failed verification or packaging must not publish a release.

GitHub Actions uses the repository-provided `GITHUB_TOKEN` with `contents: write`; no personal token is committed.

## Desktop Update Architecture

The packaged Electron main process uses `electron-updater` with the repository's GitHub Releases feed. Development builds never contact the update provider.

Shortly after startup, and periodically while running, the main process checks for updates. State changes are converted into a small shared update-status model and sent to the renderer through the existing context-isolated preload bridge.

States:

- `idle`: no active update operation.
- `checking`: checking GitHub Releases.
- `available`: a newer version exists.
- `downloading`: update download in progress, optionally with percentage.
- `ready`: update is downloaded and can be installed.
- `current`: this installation is current.
- `error`: the last update operation failed, with a safe message.

The updater does not install or restart automatically. When the state is `ready`, the pet displays **Restart and update**. Clicking it invokes a dedicated IPC handler that calls Electron Updater's quit-and-install operation.

## User Experience

The pet prompt dock shows update information only when actionable or when an error occurs:

- `available` or `downloading`: concise download status.
- `ready`: **Restart and update** button.
- `error`: concise failure message and a **Retry update** action.

Normal assistant actions remain usable while an update downloads. The updater must not steal focus, open a separate window, or interrupt listening/thinking.

The tray menu includes **Check for updates** as a manual fallback.

## Security and Failure Handling

- Update metadata and artifacts come only from the configured GitHub repository over HTTPS.
- Renderer code cannot supply an update URL or executable path.
- Only the Electron main process can check, download, or install updates.
- Update errors are written to the existing desktop log and surfaced without crashing the pet.
- Single-instance behavior remains active during update checks.
- The workflow publishes only after tests and builds pass.
- Windows may continue showing an unknown-publisher warning until code signing is configured. Automatic updating does not remove that warning.

## Versioning

The checked-in development version remains `0.1.0`. CI passes the generated version to Electron Builder for packaging without committing version bumps back to `main`. GitHub run numbers are monotonically increasing within the repository, so each published package has a version newer than the previous CI release.

The workflow must ensure the generated version is valid semantic versioning and that the release tag, installer metadata, and `latest.yml` all reference the same version.

## Testing

- Unit-test normalization of Electron Updater events into shared update states.
- Verify development mode does not check for updates.
- Verify packaged startup schedules an initial check.
- Verify the preload exposes invoke/listener APIs without exposing arbitrary URLs.
- Verify the renderer displays **Restart and update** only in the `ready` state.
- Verify retry and install actions call the correct IPC handlers.
- Validate the GitHub workflow and Electron Builder publish configuration through source checks.
- Run desktop tests, desktop typecheck, Electron wiring checks, and the web production build before publishing.

## Delivery

Implementation is committed on the feature branch, verified locally, pushed to `main`, and observed through the first GitHub Actions release run. The resulting GitHub Release installer becomes the initial auto-update-capable build; existing older installations must install that release manually once before they can receive future automatic updates.
