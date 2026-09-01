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
