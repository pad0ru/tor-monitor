# tor-relay-agent

Runs on the same machine as your Tor relay. Talks to Tor's ControlPort
directly and exposes live bandwidth + uptime as JSON on a localhost-only
HTTP port. Never expose this port to the public internet — reach it only
through an SSH tunnel (the Electron app does this for you).

## Requirements

- Tor already running with `ControlPort 9051` and `CookieAuthentication 1`
  set in `torrc` (you already have this from the nyx setup).
- Your user must be able to read the cookie file. On Debian, that means
  being in the `debian-tor` group:
  ```
  sudo usermod -a -G debian-tor $USER
  ```
  then log out and back in.
- Node.js installed (`sudo apt install nodejs`).

## Find your cookie path

```
sudo grep -i CookieAuthFile /etc/tor/torrc
```

If nothing is set, Tor uses a default inside the data directory (commonly
`/run/tor/control.authcookie` on Debian's tor package). Confirm with:

```
sudo find /run /var/lib/tor -iname "*authcookie*" 2>/dev/null
```

## Run it

```
cd relay-agent
COOKIE_PATH=/run/tor/control.authcookie node server.js
```

Test locally on the relay machine:

```
curl http://127.0.0.1:5001/stats
```

You should get JSON like:

```json
{
  "ok": true,
  "uptimeSeconds": 7920,
  "version": "0.4.9.11",
  "readRateKBs": 12.4,
  "writeRateKBs": 8.1
}
```

## Run it permanently (systemd)

Create `/etc/systemd/system/tor-relay-agent.service`:

```ini
[Unit]
Description=Tor relay monitoring agent
After=tor@default.service

[Service]
Environment=COOKIE_PATH=/run/tor/control.authcookie
ExecStart=/usr/bin/node /path/to/relay-agent/server.js
Restart=on-failure
User=mypc

[Install]
WantedBy=multi-user.target
```

Then:

```
sudo systemctl daemon-reload
sudo systemctl enable --now tor-relay-agent
```

## Optional: shared-secret token

Set `AGENT_TOKEN=some-long-random-string` as an env var when starting the
agent, and the Electron app must send that same value in an
`x-agent-token` header. Not required since the port never leaves
localhost, but cheap extra insurance.
