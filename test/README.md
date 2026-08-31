# Tests

Self-contained — no Tor and no real SSH server needed. `mock-control.js`
speaks enough of Tor's control protocol (cookie AUTHENTICATE, `250-` and
multi-line `250+` GETINFO replies, connection drops) to stand in for a
relay, and the SSH side runs a real in-process SSH server via the `ssh2`
package. Throwaway host keys and a cookie file are generated into this
directory on first run.

Requires `npm install` in `electron-app/` first (the tests reuse its
`ssh2` and `electron`).

## Integration tests (headless, plain node)

```
node test/integration.test.js
```

Runs the real `electron-app/main.js` with a stubbed `electron` module.
Covers: bad password, busy local port, end-to-end stats through the SSH
tunnel (mock control port → relay agent → tunnel → main process), a real
Onionoo HTTPS lookup (needs internet), terminal open/echo/resize, hard
SSH drop → auto-reconnect → stats resume → terminal reopen, clean
disconnect, unreachable agent, host-key change refusal (TOFU pinning),
and invalid fingerprint handling.

## End-to-end UI test (real Electron window)

```
cd electron-app && npx electron ../test/e2e-electron.js   # add --no-sandbox on Linux/WSL
```

Opens the real app window, fills the connect form against the mock SSH
server, and verifies the status panel, live chart, xterm terminal
round-trip, disconnect, and that the renderer logs no console errors.

## Agent-only manual poke

```
node test/mock-control.js                # MOCK_PORT, MOCK_COOKIE env vars
MOCK_MULTILINE=1 ...                     # add a 250+ data reply per GETINFO
MOCK_DROP_AFTER=3 ...                    # drop the connection after N GETINFOs
```

then run `relay-agent/server.js` pointed at it and curl `/stats`.
