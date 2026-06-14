# PersonalAI local bridge

A tiny companion process that runs **on your computer** and is the only thing
allowed to launch local apps for the voice assistant. The web app (on Vercel)
can't touch your machine — it only *proposes* an action, you confirm it in the
browser, and the browser forwards it here.

## Run it

```bash
npm run bridge
```

It prints a **token** and saves it to `scripts/bridge/.bridge-token` (gitignored).

## Connect the web app

1. Open the PersonalAI web app.
2. Click **bridge settings** under the mic.
3. Leave the URL as `http://127.0.0.1:7777`, paste the **token**, click **Save**,
   then **Test** — it should say *connected*.

Now try any of these — Jarvis asks to confirm, say **yes** (or tap **Allow**):

- "Jarvis, open YouTube" / "open my Gmail" / "go to espn.com" → opens the site
- "Jarvis, search for ramen recipes" → opens a Google search
- "Jarvis, play Bohemian Rhapsody" → opens Spotify on that song (doesn't auto-play)
- "Jarvis, open Notepad" / "open Discord" / "open calculator" → launches the app

### App vs website

A bare "open X" (or "open the X app") **tries the desktop app first** and falls
back to the website if the app isn't installed. Say "open the X **website**" to
force the browser.

Apps are resolved (in `resolveApp`, win32) by, in order:

1. `APP_ALIASES` — protocol launches (Spotify `spotify:`, Calculator `calc:`)
2. `Get-StartApps` — everything in the Start menu, incl. Microsoft Store/UWP apps
3. `%LocalAppData%` scan — per-user "Squirrel" apps with no Start entry (Discord…)
4. on PATH (`Get-Command`)

Name matching is exact → starts-with → contains. If an app still isn't found,
add it to `APP_ALIASES` with its launch target.

## Safety

- Binds to `127.0.0.1` only — not reachable from the network.
- Requires the bearer token on every request.
- By default only two verbs (`open` a validated URL/URI, `open_app` a validated
  app name) — never arbitrary shell. Targets are strictly validated and
  single-quoted, so user/agent input can't inject commands. Nothing launches
  until you confirm.

## Developer mode (arbitrary PowerShell)

**Off by default.** When you opt in, Jarvis can propose a PowerShell command and
run it on your machine. This intentionally removes the "never free shell"
guarantee above, so only enable it on a machine you trust:

```powershell
# Windows PowerShell
$env:BRIDGE_ALLOW_SHELL = "1"; npm run bridge
```

The startup banner shows **DEVELOPER MODE ON** when it's live. How it stays sane:

1. **You opt in** with `BRIDGE_ALLOW_SHELL=1`; otherwise `run_shell` is rejected.
2. **Two static gates** (in `inspectShell`): commands that *hide what they do*
   (encoded/`iex`/remote-fetch/obfuscated) are refused so what you confirm is
   what runs; commands that are *destructive/privileged* (delete, overwrite,
   format, registry, shutdown, services, Defender) are vetoed outright.
3. **You confirm the literal command** — the browser shows the exact command
   text and you **tap Run**. There is no spoken "yes" for shell, by design.
4. **Sandboxed exec** — runs `-NoProfile -NonInteractive` with a 15s timeout;
   stdout/stderr are captured and shown back in the UI.

The gates are a guard against the model's *mistakes*, not a proof of safety —
the human reading the command is the real check. Say e.g. *"Jarvis, run the
command get-date"* or *"in PowerShell, list the top 5 processes by CPU"*.

## Notes

- Works on Windows, macOS, and Linux (each app has a per-OS launcher).
- Browsers allow HTTPS pages to call `127.0.0.1`, so this works even though the
  web app is served over HTTPS.
