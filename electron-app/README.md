# tor-relay-monitor (Electron app)

Cross-platform (Windows/Mac/Linux) desktop app that shows live bandwidth
and relay status for your home Tor relay. Talks to `relay-agent` over an
SSH tunnel for live numbers, and to the public Onionoo API directly for
flags/consensus weight.

## Install

```
cd electron-app
npm install
npm start
```

## Connect

Fill in the form with:

- **SSH host** — your relay machine's address (or a Tailscale/dyndns
  hostname if you're monitoring from outside your LAN)
- **SSH username/password or private key path** — whatever you use to
  SSH into `anuspc` normally
- **Agent port on relay** — the `HTTP_PORT` the agent is listening on
  (default `5001`)
- **Local tunnel port** — any free port on your own machine, e.g. `15001`
- **Relay fingerprint** — the 40-char hex from Relay Search, used to pull
  flags/consensus weight from Onionoo

Click **Connect**. The app opens an SSH connection, tunnels a local port
to the agent's HTTP port on the relay, and starts polling both the agent
and Onionoo.

## Terminal

Once connected, an **Open terminal** button appears. It reuses the same
SSH connection (no second login) to open an interactive shell channel,
rendered with `xterm.js` — a real terminal in the app, so you can run
`nyx`, `journalctl -f`, or anything else directly on the relay without
switching to PuTTY/a separate SSH client.

## Server tools: Task manager and Server specs

Once connected, a **Server tools** row appears with two buttons. Each
opens its own window and runs plain shell commands over the *same* SSH
connection (an `exec` channel per refresh — no second login, and nothing
to install on the relay beyond a normal Linux userland: `ps`, `lscpu`,
`lsblk`, `df`, and `/proc` + `/sys`).

- **Task manager** — live process list (PID, name, user, CPU %, memory,
  threads, state, full command line), sortable by any column and
  filterable by name/user/PID/command. Summary tiles show system CPU %,
  memory used/total, load average, process count and uptime. Select a
  row and press **End process** (SIGTERM) or **Force kill** (SIGKILL) —
  a confirm bar appears first; `Delete` / `Shift+Delete` do the same for
  the selected row. CPU % is computed from `/proc/<pid>/stat` tick deltas
  between two refreshes (top-style, 100 % = one core), so the first
  reading shows `…` until the second sample arrives. A non-root SSH user
  can only end its own processes; ending someone else's (e.g. `tor`,
  which runs as `debian-tor`) gets a clear permission-denied message —
  use `sudo` in the terminal for those. PID 1 is refused outright.
- **Server specs** — hardware and health overview, refreshed every 5 s:
  an Ubuntu-MOTD-style summary (load, root filesystem usage, memory/swap
  usage, CPU temperature, process/user counts, IPv4), plus cards for the
  system (hostname, machine model, OS, kernel, uptime, GPU), CPU (model,
  cores/threads, current/max clock, usage), memory/swap bars, temperature
  sensors from `hwmon` (with `thermal_zone` as fallback), physical disks
  and mounted filesystems with usage bars.

If the SSH link drops, both windows show "Not connected to the server"
and pick up again automatically once the app has reconnected.

## Security model

The app is built to a "trust the user, not the wire or the relay's output"
posture:

- **SSH host-key pinning (TOFU).** The relay's key is pinned on first
  connect (`known_hosts.json` in userData); a later mismatch is refused
  with a MITM warning, so a swapped key can't silently harvest your
  password.
- **Credentials stay in memory.** Password/passphrase/key and the agent
  token are held only for the session (for auto-reconnect) and never
  written to disk or logged.
- **Relay agent is localhost-only.** It binds `127.0.0.1`, reached only
  through the SSH tunnel, with an optional shared token compared in
  constant time.
- **Renderer is locked down.** `contextIsolation` on, `nodeIntegration`
  off, `sandbox` on, a strict CSP (`connect-src 'none'`) on every page,
  and all server-supplied text (process names, command lines,
  os-release, etc.) rendered via `textContent`/DOM APIs — never
  `innerHTML`. The main process denies pop-ups (`setWindowOpenHandler`),
  off-`file://` navigation (`will-navigate`), `<webview>` embedding, and
  all device-permission requests.
- **Kill is validated.** `sysinfo:kill` only accepts a positive integer
  pid and a `TERM`/`KILL` signal, refuses PID 1, and never interpolates
  unchecked input into a shell string. The task manager tracks the
  selected process by pid **and** name, so a recycled pid can't redirect
  a kill at an unrelated process.
- **Hostile-output hardening (defense in depth).** All parsers of relay
  command output build null-prototype objects and drop
  `__proto__`/`constructor`/`prototype` keys, so a compromised relay
  can't pollute `Object.prototype`. Each `exec` is bounded by a timeout
  (covering channel-open too) and an output cap, so a wedged or flooding
  relay can't hang or exhaust the app.

## How the pieces fit together

```
Electron app (your PC)                Relay machine (anuspc)
┌─────────────────────┐   SSH tunnel   ┌─────────────────────┐
│ main.js              │◄──────────────►│ relay-agent/server.js│
│  - forwards local port│                │  - talks to Tor's    │
│    to agent's HTTP    │                │    ControlPort        │
│  - polls /stats        │                │  - serves /stats     │
│                        │                │    (bandwidth/uptime)│
│  - also fetches        │                └─────────────────────┘
│    Onionoo directly    │
│    (public internet,   │        Tor directory authorities
│    no tunnel needed)   │◄─────────────────────────────────────
└─────────────────────┘
```

Bandwidth/uptime need the tunnel because they only exist on the relay's
local ControlPort. Flags and consensus weight are already public, so the
app fetches those straight from `onionoo.torproject.org` — no need to
route that through SSH.

## Packaging for distribution

Once you're happy with it, `electron-builder` or `electron-forge` can
package this into a `.exe`/`.dmg`/`.AppImage`. Not wired up yet — worth
adding once the core monitoring loop feels solid.

## Connection loss & reconnect

If the SSH connection drops mid-session (wifi blip, relay reboot, laptop
sleep), the app now detects it via SSH keepalives, shows "connection lost
— reconnecting…" next to the buttons, and retries automatically with
backoff (2s doubling up to 30s) until it succeeds or you hit Disconnect.
The terminal channel dies with the connection — after a reconnect, press
**Open terminal** again for a fresh shell.

## Host key pinning

The app pins the relay's SSH host key on first connect
(trust-on-first-use), stored in `known_hosts.json` inside Electron's
userData directory. If the key later changes you get a refusal naming
that file — reinstalling the relay's OS legitimately changes the key, in
which case delete the file and reconnect.

## Known rough edges (fine for now, worth revisiting)

- Password/private key are kept in memory only for the session, never
  written to disk — but the form doesn't persist your connection details
  between launches yet. (Credentials are also kept in memory while
  connected so auto-reconnect can re-dial.)
- Only one terminal session at a time — opening it again while one is
  already running replaces it.
- The task manager / specs windows are Linux-only (they read `/proc` and
  `/sys` on the server), which is fine for the relay but means they'd
  show an error against a macOS/BSD host.
- No packaged installer yet, just `npm start` in dev mode.
