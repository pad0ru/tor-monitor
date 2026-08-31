# Tor relay monitor

Two pieces:

1. **relay-agent/** — tiny Node script that runs on `anuspc` (your relay
   machine), reads live bandwidth/uptime from Tor's ControlPort, and
   serves it as JSON on localhost.
2. **electron-app/** — desktop app for Windows/Mac that SSH-tunnels to
   the agent for live numbers, and pulls flags/consensus weight straight
   from the public Onionoo API.

## Quick start

On the relay machine:

```
cd relay-agent
npm start   # after setting COOKIE_PATH, see relay-agent/README.md
```

On your Windows/Mac machine:

```
cd electron-app
npm install
npm start
```

Then fill in the connection form in the app (SSH details + your relay's
fingerprint) and hit Connect.

See each folder's README for details — `relay-agent/README.md` covers
finding your cookie path and running it as a systemd service;
`electron-app/README.md` covers the connection form and how the tunnel
works.
