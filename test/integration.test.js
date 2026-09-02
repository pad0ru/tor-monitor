'use strict';
/**
 * Integration tests for electron-app/main.js — run with:  node test/integration.test.js
 *
 * - Stubs the 'electron' module (fake-electron.js) so the REAL main.js
 *   runs under plain node; ipc handlers are invoked directly.
 * - Runs a REAL SSH server (ssh2.Server) in-process: password auth,
 *   direct-tcpip forwarding, shell with pty + window-change, exec (runs
 *   the command locally with /bin/sh, so the task manager / specs
 *   checks see this machine's real /proc data), and a hard-drop switch
 *   for testing reconnect.
 * - Spawns the mock Tor control port + the real relay agent so the
 *   tunnel test is end-to-end.
 * - Makes one real HTTPS request to onionoo.torproject.org (a lookup
 *   that matches no relay); that check fails if you are offline.
 */
const path = require('path');
const net = require('net');
const fs = require('fs');
const Module = require('module');
const os = require('os');
const { spawn } = require('child_process');
const { TEST_DIR, REPO, ensureHostKey, startAgentStack } = require('./setup');

const APP_DIR = path.join(REPO, 'electron-app');
const SSH_PORT = 12222;
const CONTROL_PORT = 19070;
const AGENT_HTTP_PORT = 15071;
const LOCAL_PORT = 15072;

// --- electron stub injection ---
process.env.FAKE_USERDATA = TEST_DIR;
const fakeElectronPath = path.join(TEST_DIR, 'fake-electron.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return fakeElectronPath;
  return origResolve.call(this, request, ...rest);
};
const fake = require(fakeElectronPath);
const ssh2 = require(path.join(APP_DIR, 'node_modules', 'ssh2'));

// fresh TOFU state per run
try { fs.unlinkSync(path.join(TEST_DIR, 'known_hosts.json')); } catch (_e) {}

// --- test helpers ---
let failures = 0;
function check(name, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (!cond) failures++;
  console.log(`[${mark}] ${name}${extra ? ' — ' + extra : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function waitForSend(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fake.__offSend(watcher);
      reject(new Error('timeout waiting for ' + label));
    }, timeoutMs);
    const watcher = (evt) => {
      if (pred(evt)) {
        clearTimeout(timer);
        fake.__offSend(watcher);
        resolve(evt);
      }
    };
    fake.__onSend(watcher);
  });
}

// --- mock SSH server ---
const shellState = { received: '', windowChanges: [] };
const liveConns = new Set();

const sshServer = new ssh2.Server({ hostKeys: [ensureHostKey('ssh_host_key.pem')] }, (client) => {
  liveConns.add(client);
  client.on('close', () => liveConns.delete(client));
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'testuser' && ctx.password === 'testpass') {
      ctx.accept();
    } else {
      ctx.reject(['password']);
    }
  });
  client.on('ready', () => {
    client.on('tcpip', (accept, reject, info) => {
      const channel = accept();
      const out = net.connect(info.destPort, '127.0.0.1');
      out.on('error', () => channel.close());
      channel.on('error', () => out.destroy());
      out.on('connect', () => channel.pipe(out).pipe(channel));
      out.on('close', () => channel.close());
      channel.on('close', () => out.destroy());
    });
    client.on('session', (accept) => {
      const session = accept();
      let ptyInfo = null;
      session.on('pty', (accept, reject, info) => {
        ptyInfo = info;
        accept && accept();
      });
      session.on('window-change', (accept, reject, info) => {
        shellState.windowChanges.push(info);
        accept && accept();
      });
      session.on('exec', (accept, reject, info) => {
        const stream = accept();
        stream.on('error', () => {});
        const child = spawn('/bin/sh', ['-c', info.command], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => stream.write(d));
        child.stderr.on('data', (d) => stream.stderr.write(d));
        child.on('close', (code) => { stream.exit(code == null ? 1 : code); stream.end(); });
        child.on('error', () => { stream.exit(127); stream.end(); });
      });
      session.on('shell', (accept) => {
        const stream = accept();
        stream.write(`mockshell pty=${ptyInfo ? ptyInfo.cols + 'x' + ptyInfo.rows : 'none'}$ `);
        stream.on('data', (d) => {
          shellState.received += d.toString('utf8');
          stream.write(d); // echo
        });
        stream.on('error', () => {});
      });
    });
  });
});

function dropAllSshConns() {
  for (const c of liveConns) {
    // hard drop at the TCP level, like a network failure
    try { c._sock.destroy(); } catch (_e) { c.end(); }
  }
}

// --- load the real main.js ---
require(path.join(APP_DIR, 'main.js'));

const baseCfg = {
  sshHost: '127.0.0.1',
  sshPort: SSH_PORT,
  sshUsername: 'testuser',
  password: 'testpass',
  agentHost: '127.0.0.1',
  agentPort: AGENT_HTTP_PORT,
  localPort: LOCAL_PORT,
  agentPollIntervalMs: 500,
  // syntactically valid fingerprint that (almost certainly) matches no
  // relay -> exercises the real Onionoo HTTPS path, expects relay:null
  fingerprint: '0000000000000000000000000000000000000001',
};

let stack = null;

async function main() {
  stack = await startAgentStack({ controlPort: CONTROL_PORT, agentPort: AGENT_HTTP_PORT });
  console.log('[driver] relay agent up on', AGENT_HTTP_PORT);
  await new Promise((r) => sshServer.listen(SSH_PORT, '127.0.0.1', r));
  console.log('[driver] mock SSH server on', SSH_PORT);

  // 1. wrong password should reject cleanly
  // monitor:connect returns { ok: false, error } rather than throwing (so
  // the renderer can show a clean message without Electron's IPC prefix).
  {
    const res = await fake.__invoke('monitor:connect', { ...baseCfg, password: 'wrong' });
    check('connect rejects on bad password', res.ok === false && /login failed/i.test(res.error), res.error);
  }

  // 2. local port already in use -> reject, and no SSH connection leaked
  const blocker = net.createServer(() => {});
  await new Promise((r) => blocker.listen(LOCAL_PORT, '127.0.0.1', r));
  {
    const res = await fake.__invoke('monitor:connect', baseCfg);
    check('connect rejects when local port busy', res.ok === false && /already in use/i.test(res.error), res.error);
  }
  await sleep(300);
  check('no SSH connection leaked after failed setup', liveConns.size === 0, `live=${liveConns.size}`);
  await new Promise((r) => blocker.close(r));

  // 3. successful connect -> agent stats flow end-to-end through tunnel
  const statsPromise = waitForSend(
    (e) => e.channel === 'agent-stats' && e.payload && e.payload.ok === true,
    8000, 'agent-stats ok');
  const onionooPromise = waitForSend((e) => e.channel === 'onionoo-stats', 20000, 'onionoo-stats');
  await fake.__invoke('monitor:connect', baseCfg);
  check('connect resolves', true);
  const stats = (await statsPromise).payload;
  check('agent stats through tunnel', stats.ok === true && typeof stats.readBytes === 'number',
    JSON.stringify({ up: stats.uptimeSeconds, r: stats.readRateKBs, w: stats.writeRateKBs }));
  try {
    const oo = (await onionooPromise).payload;
    check('onionoo poll returned (needs internet)', oo.ok === true && oo.relay === null,
      JSON.stringify(oo).slice(0, 120));
  } catch (err) {
    check('onionoo poll returned (needs internet)', false, err.message);
  }

  // 4. terminal: start, echo, resize
  const promptPromise = waitForSend(
    (e) => e.channel === 'terminal-data' && /mockshell pty=100x30\$/.test(e.payload),
    5000, 'shell prompt');
  await fake.__invoke('terminal:start', { cols: 100, rows: 30 });
  await promptPromise;
  check('terminal opens with requested pty size', true);
  const echoPromise = waitForSend(
    (e) => e.channel === 'terminal-data' && e.payload.includes('hello-relay'),
    5000, 'echo');
  fake.__emit('terminal:input', 'hello-relay\n');
  await echoPromise;
  check('terminal input echoed back', shellState.received.includes('hello-relay'));
  fake.__emit('terminal:resize', { cols: 132, rows: 40 });
  await sleep(400);
  const wc = shellState.windowChanges[shellState.windowChanges.length - 1];
  check('resize propagated as window-change', !!wc && wc.cols === 132 && wc.rows === 40,
    JSON.stringify(wc));
  // bogus resize must not crash or be forwarded
  fake.__emit('terminal:resize', { cols: NaN, rows: -3 });
  await sleep(200);
  check('bogus resize ignored', shellState.windowChanges.length === 1 ||
    shellState.windowChanges[shellState.windowChanges.length - 1].cols === 132);

  // 4b. server tools (task manager + specs) over the same SSH connection.
  // The mock sshd runs the collection scripts locally, so the numbers
  // can be cross-checked against this process / node's os module.
  {
    const first = await fake.__invoke('sysinfo:processes');
    check('process list returned', first.ok === true && Array.isArray(first.processes) && first.processes.length > 5,
      first.error || `n=${first.processes && first.processes.length}`);
    const me = first.ok ? first.processes.find((p) => p.pid === process.pid) : null;
    check('own process present with user/args/rss/threads',
      !!me && me.user !== '?' && /node|electron/i.test(me.args) && me.rssBytes > 0 && me.threads >= 1,
      JSON.stringify(me && { user: me.user, args: me.args.slice(0, 40), rss: me.rssBytes, thr: me.threads }));
    check('first sample has no CPU % yet (needs a delta)', first.cpuPercent === null && !!me && me.cpuPercent === null);
    const busyUntil = Date.now() + 300; // burn CPU so our own delta is > 0
    while (Date.now() < busyUntil) { /* spin */ }
    await sleep(200);
    const second = await fake.__invoke('sysinfo:processes');
    const me2 = second.ok ? second.processes.find((p) => p.pid === process.pid) : null;
    check('second sample has system + per-process CPU %',
      second.ok && typeof second.cpuPercent === 'number' && !!me2 && typeof me2.cpuPercent === 'number' && me2.cpuPercent > 0,
      JSON.stringify({ sys: second.cpuPercent, me: me2 && me2.cpuPercent }));
    check('memory/load/uptime summary parsed',
      second.ok && second.mem.totalBytes === os.totalmem() && second.mem.usedBytes > 0 &&
      Array.isArray(second.load) && second.load.length === 3 && second.uptimeSeconds > 0 && second.ncpu >= 1,
      JSON.stringify({ mem: second.mem, load: second.load, ncpu: second.ncpu }));

    // kill: a throwaway child of ours must exit on TERM
    const victim = spawn('sleep', ['300'], { stdio: 'ignore' });
    const victimExit = new Promise((r) => victim.on('exit', (_code, sig) => r(sig)));
    await sleep(200);
    const k = await fake.__invoke('sysinfo:kill', { pid: victim.pid, signal: 'TERM' });
    const sig = await Promise.race([victimExit, sleep(3000).then(() => 'timeout')]);
    check('kill TERM ends own process', k.ok === true && sig === 'SIGTERM', JSON.stringify({ k, sig }));
    const bad = await fake.__invoke('sysinfo:kill', { pid: '1; rm -rf /', signal: 'TERM' });
    check('kill rejects non-integer pid (no shell injection)', bad.ok === false && /invalid/i.test(bad.error), bad.error);
    const init = await fake.__invoke('sysinfo:kill', { pid: 1 });
    check('kill refuses PID 1', init.ok === false && /PID 1/.test(init.error), init.error);
    if (process.getuid && process.getuid() !== 0) {
      const other = await fake.__invoke('sysinfo:kill', { pid: 2, signal: 'KILL' }); // root-owned
      check("kill of another user's process -> permission denied message",
        other.ok === false && /permission denied/i.test(other.error), other.error);
    }
    const gone = await fake.__invoke('sysinfo:kill', { pid: 4194300 });
    check('kill of missing pid -> no longer exists message', gone.ok === false && /no longer exists/i.test(gone.error), gone.error);

    const specs = await fake.__invoke('sysinfo:specs');
    check('specs: hostname / os / kernel', specs.ok === true && specs.system.hostname === os.hostname() &&
      typeof specs.system.os === 'string' && /Linux/.test(specs.system.kernel || ''),
      specs.error || JSON.stringify(specs.system));
    check('specs: cpu model + thread count', specs.ok && typeof specs.cpu.model === 'string' && specs.cpu.model.length > 3 &&
      specs.cpu.threads === os.cpus().length, JSON.stringify(specs.cpu));
    check('specs: memory total matches os.totalmem()', specs.ok && specs.memory.totalBytes === os.totalmem());
    check('specs: root filesystem listed with usage', specs.ok &&
      specs.filesystems.some((f) => f.mount === '/' && f.sizeBytes > 0 && f.usedPercent >= 0),
      JSON.stringify(specs.filesystems).slice(0, 160));
    check('specs: disks + temperatures are arrays', specs.ok && Array.isArray(specs.disks) && Array.isArray(specs.temperatures),
      `disks=${specs.disks && specs.disks.length} temps=${specs.temperatures && specs.temperatures.length}`);
    check('specs: uptime/load/process count', specs.ok && specs.system.uptimeSeconds > 0 && Array.isArray(specs.system.load) &&
      specs.system.processes > 5);
  }

  // 5. hard-drop the SSH connection mid-session -> reconnect + stats resume
  const reconStatus = waitForSend(
    (e) => e.channel === 'ssh-status' && e.payload.state === 'reconnecting',
    5000, 'ssh-status reconnecting');
  const closedMsg = waitForSend(
    (e) => e.channel === 'terminal-data' && e.payload.includes('[session closed]'),
    5000, 'terminal session closed notice');
  const reconnected = waitForSend(
    (e) => e.channel === 'ssh-status' && e.payload.state === 'connected' && e.payload.reconnected,
    15000, 'reconnected status');
  dropAllSshConns();
  await reconStatus;
  check('renderer notified of SSH drop', true);
  try {
    await closedMsg;
    check('terminal notified of closed session', true);
  } catch (e) {
    check('terminal notified of closed session', false, e.message);
  }
  await reconnected;
  check('auto-reconnect succeeded', true);
  const statsAfter = await waitForSend(
    (e) => e.channel === 'agent-stats' && e.payload && e.payload.ok === true,
    8000, 'agent-stats after reconnect');
  check('agent stats resumed after reconnect', statsAfter.payload.ok === true);

  // 6. terminal restart on the new connection
  const prompt2 = waitForSend(
    (e) => e.channel === 'terminal-data' && /mockshell pty=/.test(e.payload), 5000, 'second shell');
  await fake.__invoke('terminal:start', { cols: 80, rows: 24 });
  await prompt2;
  check('terminal reopens on reconnected client', true);

  // 7. clean disconnect: no reconnect attempts afterwards
  await fake.__invoke('monitor:disconnect');
  await sleep(3300);
  check('disconnect stays disconnected (no zombie reconnect)', liveConns.size === 0,
    `live=${liveConns.size}`);
  {
    const r = await fake.__invoke('sysinfo:processes');
    check('server tools report not connected after disconnect', r.ok === false && /not connected/i.test(r.error), r.error);
  }

  // 8. unreachable agent: connect with agentPort pointing nowhere
  const unreachable = waitForSend(
    (e) => e.channel === 'agent-stats' && e.payload.ok === false, 8000, 'unreachable agent stats');
  await fake.__invoke('monitor:connect', { ...baseCfg, agentPort: 59999, fingerprint: undefined });
  const un = (await unreachable).payload;
  check('unreachable agent reported as error, no crash', un.ok === false, un.error);
  await fake.__invoke('monitor:disconnect');

  // 9. host key pinning: same host:port with a DIFFERENT host key must
  // be refused (TOFU pin was stored during the first successful connect)
  await new Promise((r) => sshServer.close(r));
  dropAllSshConns();
  await sleep(300);
  const evilServer = new ssh2.Server({ hostKeys: [ensureHostKey('ssh_host_key_evil.pem')] },
    (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => ctx.accept());
    });
  await new Promise((r) => evilServer.listen(SSH_PORT, '127.0.0.1', r));
  {
    const res = await fake.__invoke('monitor:connect', { ...baseCfg, fingerprint: undefined });
    check('changed host key refused (MITM protection)', res.ok === false && /host key .* changed/i.test(res.error),
      (res.error || '').slice(0, 100));
  }
  await new Promise((r) => evilServer.close(r));
  await new Promise((r) => sshServer.listen(SSH_PORT, '127.0.0.1', r));

  // 10. invalid fingerprint -> onionoo error event, not a crash
  const badFp = waitForSend(
    (e) => e.channel === 'onionoo-stats' && e.payload.ok === false, 8000, 'bad fingerprint error');
  await fake.__invoke('monitor:connect', { ...baseCfg, fingerprint: 'not-a-fingerprint' });
  const bf = (await badFp).payload;
  check('invalid fingerprint rejected safely', /40 hex/.test(bf.error || ''), bf.error);
  await fake.__invoke('monitor:disconnect');

  console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
  stack.stop();
  process.exit(failures === 0 ? 0 : 1);
}

process.on('unhandledRejection', (err) => {
  console.log('[FAIL] unhandled rejection:', err && err.message);
  if (stack) stack.stop();
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.log('[FAIL] uncaught exception (main process would have crashed):', err && err.message);
  if (stack) stack.stop();
  process.exit(1);
});

main().catch((err) => {
  console.log('[FAIL] driver error:', err && err.stack);
  if (stack) stack.stop();
  process.exit(1);
});
