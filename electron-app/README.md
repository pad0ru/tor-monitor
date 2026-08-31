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
- No packaged installer yet, just `npm start` in dev mode.
