# Changelog

## 2026-08-31

### Real-world deployment

- Deployed `relay-agent/` to the live home Tor relay (`anuspc`, 192.168.1.183) at `~/tor-monitor-relay-agent/`.
- Fixed `EACCES` on `/run/tor/control.authcookie` by adding the agent's user to the `debian-tor` group.
- Installed the agent as a systemd unit (`tor-relay-agent.service`, enabled + running), with `SupplementaryGroups=debian-tor` so it doesn't depend on interactive group membership.
- Verified end-to-end: Electron app connects over SSH tunnel, pulls live stats (uptime, Tor version, read/write rates) from the relay and renders the bandwidth chart.

### Bug fixes

- **Renderer swallowed real agent errors.** `onAgentStats` was showing a generic "agent unreachable" for every failure, hiding the actual cause (e.g. permission errors). Now shows `stats.error` when present.
- **Raw SSH errors leaked to the UI.** A wrong password surfaced as `Connection failed: Error invoking remote method 'monitor:connect': Error: All configured authentication methods failed` — an internal Electron IPC wrapper message, not something a user can act on.
  - `monitor:connect` no longer throws on connection failure; it returns `{ ok: false, error }` so the renderer can show a clean message without Electron's IPC error prefix.
  - Added `friendlyConnectError()` in `main.js` mapping common ssh2/net failures to plain-language messages: wrong credentials, host unreachable (`ECONNREFUSED`), unknown host (`ENOTFOUND`), timeout, local port already in use, and host-key mismatch (MITM warning).

### Packaging

- Added `electron-builder` devDependency and a `build` config in `electron-app/package.json` (`dist` script) for producing a Windows NSIS installer, macOS DMG, and Linux AppImage. The Windows `.exe` build still needs to run from native Windows (requires Node.js installed there) — not yet built.

### Tooling

- Confirmed the app runs via `npm start` in WSL (WSLg) against the live relay. GPU/zygote errors in the console are the normal WSLg software-rendering fallback and can be ignored.

### Follow-up fixes (same day, after initial testing)

- **Terminal didn't refresh across sessions.** Switching SSH users (or reconnecting) opened a fresh shell in the backend, but the xterm display kept the old session's screen, scrollback, and any leftover terminal mode (e.g. an alternate screen left open by vim/htop). `openTerminalBtn` now calls `term.reset()` before starting each new session, and shows `[press "Open terminal" to start a new shell]` when a session closes.
- **Friendly error mapping was incomplete.** `friendlyConnectError()` (added earlier today) was only applied to the initial `monitor:connect` call — the auto-reconnect loop and the live SSH error handler still sent raw ssh2 error text (e.g. "All configured authentication methods failed") straight to the UI. Both `scheduleReconnect()` and the live `client.on('error')` handler in `main.js` now route through `friendlyConnectError()` too. Caught by `/code-review medium`.
- Ran `/code-review medium` on the day's diff; noted but not yet acted on: `log.md` documents the relay's LAN IP, hostname, and install paths — fine while the GitHub repo stays private, but worth scrubbing before ever making it public.

### Known follow-ups

- Build and test the Windows `.exe` installer from native Windows (WSL has no Wine, so the Windows target can't be cross-built here — Linux AppImage/macOS DMG are buildable from WSL/mac respectively).
- Optional: add an app icon for the installer.
- Optional: scrub relay-identifying details (IP/hostname/paths) from `log.md` before making the repo public.

## 2026-09-01

### Bandwidth chart legend

- The chart's `Read KB/s` / `Write KB/s` datasets already had matching colors and labels but the legend was hidden. Enabled it (top-right, colored swatches) so the blue/orange lines are actually identifiable.

### Terminal copy/paste

- The embedded xterm.js terminal had no copy/paste at all — every keystroke (including Ctrl+C/Ctrl+V) is forwarded straight to the remote shell as SIGINT / literal input.
- Added keyboard shortcuts (Ctrl+Insert to copy, Ctrl+Shift+V or Shift+Insert to paste) and right-click (copies the selection if there is one, otherwise pastes).
- Skipped `Ctrl+Shift+C` for copy: it's Chromium's built-in "Inspect Element" devtools shortcut and is consumed at the browser-chrome level before any page JS sees the keystroke — no page-level fix is possible without also intercepting `before-input-event` in the main process and disabling/reclaiming that shortcut, which wasn't worth it here.
- **Bug found and fixed:** copy silently did nothing (paste appeared to work, but only because Chromium's native textarea paste fired as a side effect of the handler throwing). Root cause: the renderer runs sandboxed, so the preload's `require('electron')` doesn't include the `clipboard` module — it was `undefined`, and every copy call threw. Fixed by brokering clipboard reads/writes through IPC to the main process (`clipboard:write` / `clipboard:read` in `main.js`, real `clipboard.writeText`/`readText` there) instead of touching the module from the sandboxed preload. Paste handlers now also call `preventDefault()` so Chromium's native paste doesn't fire a second, duplicate paste alongside the deliberate one.
- Verified Electron's clipboard writes sync through WSLg to the Windows clipboard (round-tripped a test string via `powershell.exe Get-Clipboard`), so terminal copies are usable outside the WSL app too.

### Environment note

- Found `node_modules/electron` had been overwritten with **Windows** binaries (`electron.exe`) between sessions, breaking `npm start` in WSL — almost certainly from an `npm install` run from the Windows side against the same checkout. Re-ran `npm install electron` from WSL to restore the Linux binary. WSL and Windows can't share one `node_modules/electron`; keep them in separate checkouts/installs if both sides are used.

### Planned (not yet implemented)

- **Task manager for the server.** A view of processes running on the relay (list/kill), surfaced through the existing SSH connection rather than a second login.
- **Multiple SSH sessions.** Support more than one concurrent SSH/terminal session (tabs or a session list) instead of the single tunnel + single terminal the app currently supports.
- **Specs of the Server Computer** Show information about the cpu, ram, storage, current temp(similar to what ubuntu shows when it starts up)
