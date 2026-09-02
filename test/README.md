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
and invalid fingerprint handling. The mock sshd also serves `exec`
requests by running the command locally with `/bin/sh`, so the server
tools are tested against this machine's real `/proc`: process list
(own pid present, CPU % appears on the second sample, memory total
matches `os.totalmem()`), kill (TERM ends a child `sleep`; bad pid,
PID 1, another user's process and a missing pid each get their specific
error), specs (hostname/kernel/CPU model/thread count/root filesystem),
and "not connected" after disconnect. Security checks: a specs payload with `__proto__`/`constructor` keys parses correctly without polluting `Object.prototype`, and a stalled `exec` channel is bounded by the timeout (the connection recovers after).

## End-to-end UI test (real Electron window)

```
cd electron-app && npx electron ../test/e2e-electron.js   # add --no-sandbox on Linux/WSL
```

Opens the real app window, fills the connect form against the mock SSH
server, and verifies the status panel, live chart, xterm terminal
round-trip, the Task manager and Server specs windows (rows rendered,
summary tiles, row selection + confirm bar + filter, MOTD summary,
reopening reuses the window, "not connected" after disconnect; ending a real process through the UI removes its row and clears the selection; `window.open` and off-`file://` navigation are denied),
disconnect, and that no window logs console errors.

## Security-hardening verification (v0.3.1)

Two dedicated suites verify the three hardening safeguards (Electron
lockdown, hostile-relay-output parsing, and the task manager's kill-safety
fix) end to end — 72 checks across good, alternate, and bad/adversarial
flow for each, in addition to the safeguards already exercised inline in
`integration.test.js` and `e2e-electron.js`.

```
node test/security-hardening.test.js
```

Headless (30 checks). A scriptable mock sshd lets each check inject the
exact attack it needs: prototype-pollution attempts (`__proto__`/
`constructor`/`prototype` keys) in every parsed field of `sysinfo:specs`
individually and combined, the same attempt against the relay-agent's own
`repliesToMap`, a stalled exec channel (must time out, not hang), a relay
that refuses the channel outright, an output flood (must stay capped),
and the `sysinfo:kill` IPC boundary directly — PID 1, non-integer/
injection-shaped pids, negative/zero pids, and arbitrary signal strings
(must coerce to TERM, never pass through raw), independent of the task
manager UI.

```
cd electron-app && npx electron ../test/security-e2e.js   # add --no-sandbox on Linux/WSL
```

Real Electron (42 checks). Verifies the global `web-contents-created`
handler: `window.open()` denied for every URL scheme tried, a same-app
`file://` navigation still works (positive control), external navigation
blocked via five different vectors (`location.replace/assign`, an
external `<a target=_blank>`, a `<form>` submit, an injected `<meta
refresh>`, `window.top.location`), device-permission requests (camera,
geolocation, notifications) denied, `<webview>` inert, and the renderer
still has no Node globals under the newly-explicit `sandbox: true`. Also
drives the task manager's selection-safety fix two ways: real child
processes ended through the actual UI/IPC/SSH path, and a second,
mock-driven task manager window (the real unmodified `taskmanager.html`/
`.js`, fed scripted snapshots over a throwaway IPC channel) to
deterministically prove the core fix — a pid recycled by a
differently-named process clears the selection instead of silently
re-targeting a kill at it — which real OS pid reuse can't be forced to
reproduce reliably in a short test run.

## Agent-only manual poke

```
node test/mock-control.js                # MOCK_PORT, MOCK_COOKIE env vars
MOCK_MULTILINE=1 ...                     # add a 250+ data reply per GETINFO
MOCK_DROP_AFTER=3 ...                    # drop the connection after N GETINFOs
```

then run `relay-agent/server.js` pointed at it and curl `/stats`.
