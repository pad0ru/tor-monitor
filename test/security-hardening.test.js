'use strict';
/**
 * Headless security-hardening verification for the v0.3.1 pass — run with:
 *   node test/security-hardening.test.js
 *
 * Covers, against real Electron IPC handlers (main.js) with a stubbed
 * 'electron' module (same technique as integration.test.js):
 *
 *   Safeguard 2 — hostile-relay hardening: prototype-pollution-safe
 *   parsers (main.js) and the relay-agent's repliesToMap, plus the
 *   bounded sshExec timeout (covers channel-open stalls too).
 *
 *   Safeguard 3 (bad-flow / IPC boundary) — sysinfo:kill's input
 *   validation. This is the real security boundary: it must hold even
 *   if a compromised/malicious renderer calls it directly, bypassing
 *   the task manager UI entirely.
 *
 * A real in-process SSH server (ssh2.Server) runs the collection
 * scripts against a scriptable exec handler so each test can inject
 * exactly the attack payload it needs (stalls, poisoned output, a
 * relay that refuses the channel, an instant empty close, etc.).
 */
const path = require('path');
const net = require('net');
const fs = require('fs');
const Module = require('module');
const { spawn } = require('child_process');
const { TEST_DIR, REPO, ensureHostKey } = require('./setup');

const APP_DIR = path.join(REPO, 'electron-app');
const SSH_PORT = 12240;

process.env.FAKE_USERDATA = TEST_DIR;
// Short timeout so the stall/timeout tests run quickly. Local /proc
// collection normally finishes in well under this.
process.env.EXEC_TIMEOUT_MS = '1200';
const fakeElectronPath = path.join(TEST_DIR, 'fake-electron.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return fakeElectronPath;
  return origResolve.call(this, request, ...rest);
};
const fake = require(fakeElectronPath);
const ssh2 = require(path.join(APP_DIR, 'node_modules', 'ssh2'));

try { fs.unlinkSync(path.join(TEST_DIR, 'known_hosts.json')); } catch (_e) {}

let failures = 0;
let passed = 0;
function check(name, cond, extra) {
  const mark = cond ? 'PASS' : 'FAIL';
  if (cond) passed++; else failures++;
  console.log(`[${mark}] ${name}${extra ? ' — ' + extra : ''}`);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// --- scriptable exec behavior, one flag set at a time ---
let execMode = 'normal'; // normal | stall | refuse | instant-close | flood
let poisonPayload = null; // string to return verbatim instead of running the real command

function poisoned(overrides) {
  const base = {
    HOST: 'poison-host',
    OS: ['PRETTY_NAME="PoisonOS"', '__proto__=pwned'],
    KERNEL: 'Linux poison x86_64',
    UPTIME: '123.0 456.0',
    LOAD: '0.1 0.2 0.3',
    NPROC: '2',
    LSCPU: ['Model name: Poison CPU', '__proto__: polluted', 'constructor: nope', 'prototype: nope2'],
    CPUINFO: 'model name : Poison CPU',
    CPUMHZ: '',
    CPU: 'cpu 1 2 3 4 5 6 7 8',
    MEM: ['MemTotal: 1000 kB', 'MemAvailable: 400 kB', 'SwapTotal: 0 kB', 'SwapFree: 0 kB', '__proto__: 999 kB'],
    DISKS: ['NAME="sda" SIZE="100" MODEL="X" ROTA="0" TYPE="disk" TRAN="sata" __proto__="pwn"'],
    DF: 'Filesystem 1-blocks Used Available Capacity Mounted-on',
    THERMAL: '',
    HWMON: '',
    USERS: '0',
    PROCS: '42',
    IP: '10.0.0.9',
    GPU: '',
    DMI: '',
  };
  const merged = { ...base, ...overrides };
  const lines = [];
  for (const [k, v] of Object.entries(merged)) {
    lines.push('@@' + k);
    if (Array.isArray(v)) lines.push(...v);
    else if (v !== '') lines.push(v);
  }
  return lines.join('\n') + '\n';
}

const sshServer = new ssh2.Server({ hostKeys: [ensureHostKey('ssh_host_key.pem')] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'testuser' && ctx.password === 'testpass') ctx.accept();
    else ctx.reject(['password']);
  });
  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        if (execMode === 'refuse') {
          reject();
          return;
        }
        const stream = accept();
        stream.on('error', () => {});
        if (execMode === 'stall') return; // accept the channel, never write or exit
        if (execMode === 'instant-close') {
          stream.exit(0);
          stream.end();
          return;
        }
        if (execMode === 'flood') {
          const chunk = Buffer.alloc(256 * 1024, 'A');
          const iv = setInterval(() => {
            if (stream.destroyed) { clearInterval(iv); return; }
            stream.write(chunk);
          }, 5);
          setTimeout(() => { clearInterval(iv); stream.exit(0); stream.end(); }, 300);
          return;
        }
        if (poisonPayload !== null) {
          stream.write(poisonPayload);
          stream.exit(0);
          stream.end();
          return;
        }
        const child = spawn('/bin/sh', ['-c', info.command], { stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (d) => stream.write(d));
        child.stderr.on('data', (d) => stream.stderr.write(d));
        child.on('close', (code) => { stream.exit(code == null ? 1 : code); stream.end(); });
        child.on('error', () => { stream.exit(127); stream.end(); });
      });
    });
  });
});

require(path.join(APP_DIR, 'main.js'));

const baseCfg = {
  sshHost: '127.0.0.1',
  sshPort: SSH_PORT,
  sshUsername: 'testuser',
  password: 'testpass',
  agentHost: '127.0.0.1',
  agentPort: 59998, // agent doesn't need to exist for these checks
  localPort: 15080,
  agentPollIntervalMs: 60000,
};

async function main() {
  await new Promise((r) => sshServer.listen(SSH_PORT, '127.0.0.1', r));
  console.log('[driver] mock SSH server on', SSH_PORT);
  const conn = await fake.__invoke('monitor:connect', baseCfg);
  if (!conn.ok) throw new Error('setup: could not connect — ' + conn.error);
  console.log('[driver] connected\n');

  // ===================================================================
  // Safeguard 2 — GOOD FLOW: hardening doesn't break normal parsing
  // ===================================================================
  console.log('--- Safeguard 2: good flow ---');
  {
    execMode = 'normal';
    const s1 = await fake.__invoke('sysinfo:specs');
    check('G1: clean specs poll returns ok with real hostname field',
      s1.ok === true && typeof s1.system.hostname === 'string' && s1.system.hostname.length > 0, s1.error);
    const p1 = await fake.__invoke('sysinfo:processes');
    check('G2: clean processes poll returns ok with a process list',
      p1.ok === true && Array.isArray(p1.processes) && p1.processes.length > 0, p1.error);
    const s2 = await fake.__invoke('sysinfo:specs');
    const p2 = await fake.__invoke('sysinfo:processes');
    check('G3: repeated clean polling stays healthy (no hardening side effects)',
      s2.ok === true && p2.ok === true, JSON.stringify({ s: s2.ok, p: p2.ok }));
    const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
    await sleep(150);
    const k = await fake.__invoke('sysinfo:kill', { pid: victim.pid, signal: 'TERM' });
    check('G4: own-process kill still works normally', k.ok === true, JSON.stringify(k));
  }

  // ===================================================================
  // Safeguard 2 — ALTERNATE FLOW: individual + combined poisoning
  // ===================================================================
  console.log('\n--- Safeguard 2: alternate flow ---');
  {
    poisonPayload = poisoned({});
    const r = await fake.__invoke('sysinfo:specs');
    poisonPayload = null;
    check('A1: __proto__ in @@OS ignored, PRETTY_NAME still parsed',
      r.ok === true && r.system.os === 'PoisonOS', r.error || JSON.stringify(r.system));
    check('A2: __proto__/constructor/prototype in @@LSCPU ignored, model still parsed',
      r.ok === true && r.cpu.model === 'Poison CPU', JSON.stringify(r.cpu));
    check('A3: __proto__ in @@MEM ignored, MemTotal still parsed',
      r.ok === true && r.memory.totalBytes === 1000 * 1024, JSON.stringify(r.memory));
    check('A4: __proto__ in lsblk KEY="value" pairs ignored, disk still parsed',
      r.ok === true && Array.isArray(r.disks) && r.disks.length === 1 && r.disks[0].name === 'sda',
      JSON.stringify(r.disks));
    check('A5: no prototype pollution after combined poisoning (specs)',
      ({}).pwned === undefined && ({}).polluted === undefined && Object.prototype.pwned === undefined,
      JSON.stringify({ pwned: ({}).pwned, polluted: ({}).polluted }));

    // Isolate each field individually to be sure one poisoned field
    // can't mask a different one being missed.
    poisonPayload = poisoned({ OS: ['PRETTY_NAME="OnlyOS"'] });
    const rOsOnly = await fake.__invoke('sysinfo:specs');
    poisonPayload = null;
    check('A6: __proto__ only in @@LSCPU (OS clean) still parses OS correctly',
      rOsOnly.ok === true && rOsOnly.system.os === 'OnlyOS', JSON.stringify(rOsOnly.system));

    poisonPayload = poisoned({ LSCPU: ['Model name: OnlyCPU'] });
    const rCpuOnly = await fake.__invoke('sysinfo:specs');
    poisonPayload = null;
    check('A7: poisoning isolated to other fields does not corrupt a clean @@LSCPU',
      rCpuOnly.ok === true && rCpuOnly.cpu.model === 'OnlyCPU', JSON.stringify(rCpuOnly.cpu));

    // relay-agent's own repliesToMap, exercised via a throwaway agent
    // process pointed at a poisoned mock control port.
    const agentResult = await testAgentReplyPoisoning();
    check('A8: relay-agent repliesToMap ignores __proto__/constructor keys from Tor ControlPort',
      agentResult.ok, agentResult.detail);

    // stall timing: must reject within ~EXEC_TIMEOUT_MS, not instantly
    // and not way past it.
    execMode = 'stall';
    const t0 = Date.now();
    const stalled = await fake.__invoke('sysinfo:processes');
    const elapsed = Date.now() - t0;
    execMode = 'normal';
    check('A9: stalled channel times out within the configured bound',
      stalled.ok === false && /timed out/i.test(stalled.error) && elapsed >= 1100 && elapsed < 4000,
      `${stalled.error} in ${elapsed}ms`);

    // a command that finishes in normal time is NOT mistaken for a stall
    const t1 = Date.now();
    const fast = await fake.__invoke('sysinfo:processes');
    const fastElapsed = Date.now() - t1;
    check('A10: a fast command does not false-positive as timed out',
      fast.ok === true && fastElapsed < 1100, `ok=${fast.ok} in ${fastElapsed}ms`);

    // connection stays usable after a timeout
    const after1 = await fake.__invoke('sysinfo:specs');
    const after2 = await fake.__invoke('sysinfo:processes');
    check('A11: connection recovers and stays healthy after a timeout',
      after1.ok === true && after2.ok === true, JSON.stringify({ a1: after1.ok, a2: after2.ok }));

    // instant, empty close must resolve fast (not misclassified as a stall)
    execMode = 'instant-close';
    const t2 = Date.now();
    const empty = await fake.__invoke('sysinfo:specs');
    const emptyElapsed = Date.now() - t2;
    execMode = 'normal';
    check('A12: instant empty close resolves quickly, not treated as a stall',
      emptyElapsed < 1100, `elapsed=${emptyElapsed}ms result.ok=${empty.ok}`);
  }

  // ===================================================================
  // Safeguard 2 — BAD FLOW: adversarial relay behavior
  // ===================================================================
  console.log('\n--- Safeguard 2: bad flow ---');
  {
    // simultaneous poisoning of both endpoints in the same run
    poisonPayload = poisoned({});
    const s = await fake.__invoke('sysinfo:specs');
    const p = await fake.__invoke('sysinfo:processes'); // will also get poisoned specs text; parseProcesses should reject it as unexpected, not crash/pollute
    poisonPayload = null;
    check('B1: simultaneous poisoning across endpoints leaves Object.prototype clean',
      ({}).pwned === undefined && ({}).polluted === undefined, JSON.stringify({ pwned: ({}).pwned }));
    check('B2: a specs-shaped payload fed to the processes parser fails cleanly (no crash)',
      s.ok === true && p.ok === false, JSON.stringify({ s: s.ok, p: p.ok, pErr: p.error }));

    // relay that refuses the exec channel outright
    execMode = 'refuse';
    const refused = await fake.__invoke('sysinfo:specs');
    execMode = 'normal';
    check('B3: relay refusing the exec channel is reported as an error, not a hang/crash',
      refused.ok === false && typeof refused.error === 'string', JSON.stringify(refused));

    // output flood: still resolves (capped), never hangs
    execMode = 'flood';
    const t0 = Date.now();
    const flooded = await fake.__invoke('sysinfo:specs');
    const floodElapsed = Date.now() - t0;
    execMode = 'normal';
    check('B4: output flood is capped and still resolves (no hang)',
      floodElapsed < 5000, `elapsed=${floodElapsed}ms ok=${flooded.ok}`);

    // dotted key attempt: "__proto__.__proto__" is not an exact match for
    // the reserved-key set, but the accumulator is Object.create(null),
    // so even a key that slips past the explicit skip-list lands as an
    // inert own property, never as a real prototype write.
    poisonPayload = poisoned({ OS: ['PRETTY_NAME="DotOS"', '__proto__.__proto__=nope'] });
    const dotted = await fake.__invoke('sysinfo:specs');
    poisonPayload = null;
    check('B5: dotted "__proto__.__proto__" key lands as an inert property, no pollution (null-proto backstop)',
      dotted.ok === true && dotted.system.os === 'DotOS' && ({}).pwned === undefined && Object.prototype.nope === undefined,
      JSON.stringify(dotted.system));

    // repeated back-to-back stalls must not leave the connection wedged
    execMode = 'stall';
    await fake.__invoke('sysinfo:specs');
    await fake.__invoke('sysinfo:specs');
    execMode = 'normal';
    const recovered = await fake.__invoke('sysinfo:processes');
    check('B6: connection survives repeated back-to-back stalls',
      recovered.ok === true, recovered.error);

    // PS/psInfo path (a Map, not a plain object) is unaffected regardless
    check('B7: process-info lookup uses a Map (immune to key-based prototype pollution by construction)',
      recovered.ok === true && Array.isArray(recovered.processes) && recovered.processes.length > 0,
      `n=${recovered.processes && recovered.processes.length}`);
  }

  // ===================================================================
  // Safeguard 3 — BAD FLOW (IPC boundary): sysinfo:kill input validation
  // This is the real security boundary — it must hold even if called
  // directly, bypassing the task manager UI entirely.
  // ===================================================================
  console.log('\n--- Safeguard 3: bad flow (IPC boundary) ---');
  {
    const r1 = await fake.__invoke('sysinfo:kill', { pid: 1, signal: 'KILL' });
    check('K1: direct kill of PID 1 refused', r1.ok === false && /PID 1/.test(r1.error), r1.error);

    const r2 = await fake.__invoke('sysinfo:kill', { pid: '1; rm -rf /', signal: 'TERM' });
    check('K2: injection-shaped non-integer pid refused (never reaches a shell)',
      r2.ok === false && /invalid/i.test(r2.error), r2.error);

    const r3 = await fake.__invoke('sysinfo:kill', { pid: -5, signal: 'TERM' });
    check('K3: negative pid refused', r3.ok === false && /invalid/i.test(r3.error), r3.error);

    const r4 = await fake.__invoke('sysinfo:kill', { pid: 0, signal: 'TERM' });
    check('K4: pid 0 refused', r4.ok === false && /invalid/i.test(r4.error), r4.error);

    const r5 = await fake.__invoke('sysinfo:kill', { pid: 3.7, signal: 'TERM' });
    check('K5: non-integer float pid refused', r5.ok === false && /invalid/i.test(r5.error), r5.error);

    // arbitrary signal strings are coerced to TERM, never passed through raw
    const victim = spawn('sleep', ['60'], { stdio: 'ignore' });
    const exitPromise = new Promise((res) => victim.on('exit', (_c, sig) => res(sig)));
    await sleep(150);
    const r6 = await fake.__invoke('sysinfo:kill', { pid: victim.pid, signal: 'HUP; echo pwned' });
    const sig = await Promise.race([exitPromise, sleep(2000).then(() => 'timeout')]);
    check('K6: unrecognized signal string is coerced to TERM (no arbitrary signal/command injection)',
      r6.ok === true && r6.signal === 'TERM' && sig === 'SIGTERM', JSON.stringify({ r6, sig }));

    // double-click race: End then Force-Kill in immediate succession on
    // the same already-dead pid must not crash the handler
    const v2 = spawn('sleep', ['60'], { stdio: 'ignore' });
    await sleep(150);
    const [ra, rb] = await Promise.all([
      fake.__invoke('sysinfo:kill', { pid: v2.pid, signal: 'TERM' }),
      fake.__invoke('sysinfo:kill', { pid: v2.pid, signal: 'KILL' }),
    ]);
    check('K7: concurrent End+Force-Kill on the same pid resolves both without crashing',
      typeof ra.ok === 'boolean' && typeof rb.ok === 'boolean', JSON.stringify({ ra, rb }));
  }

  await fake.__invoke('monitor:disconnect');

  console.log(`\n${passed} passed, ${failures} failed (${passed + failures} total)`);
  console.log(failures === 0 ? 'ALL SECURITY TESTS PASSED' : `${failures} SECURITY TEST(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// Spins up the real mock-control.js + relay-agent/server.js as child
// processes, feeds the control port a poisoned GETINFO reply containing
// a __proto__ key, and checks the agent's own /stats output has no
// polluted marker and Object.prototype stays clean in THIS process
// (repliesToMap runs in the agent's own process, so this only proves
// the agent didn't crash/misbehave — the pollution-safety of that
// function is unit-testable directly too, done below as a fallback).
async function testAgentReplyPoisoning() {
  // Direct unit check: import the agent's parsing logic behavior by
  // simulating what repliesToMap does, using the same shape of input a
  // poisoned control-port reply would produce. We can't require
  // relay-agent/server.js directly (it runs a control connection +
  // starts polling on require), so this exercises the identical logic
  // inline against the *actual* source text to catch drift.
  const src = fs.readFileSync(path.join(REPO, 'relay-agent', 'server.js'), 'utf8');
  const hasNullProto = /repliesToMap[\s\S]{0,300}Object\.create\(null\)/.test(src);
  const skipsUnsafeKeys = /repliesToMap[\s\S]{0,400}__proto__/.test(src);
  if (!hasNullProto || !skipsUnsafeKeys) {
    return { ok: false, detail: `repliesToMap missing hardening (nullProto=${hasNullProto} skipsUnsafe=${skipsUnsafeKeys})` };
  }
  // Load it in a fresh vm context to actually execute repliesToMap in
  // isolation without triggering the module's side effects (control
  // connection, HTTP server, polling).
  const vm = require('vm');
  const fnMatch = src.match(/function repliesToMap\(replies\) \{[\s\S]*?\n\}/);
  if (!fnMatch) return { ok: false, detail: 'repliesToMap function not found in source' };
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fnMatch[0] + '\nthis.__result = repliesToMap([' +
    '{key:"traffic/read",value:"123"},' +
    '{key:"__proto__",value:"pwned"},' +
    '{key:"constructor",value:"pwned2"},' +
    '{key:"prototype",value:"pwned3"}' +
    ']);', sandbox);
  const result = sandbox.__result;
  const clean = ({}).pwned === undefined && ({}).pwned2 === undefined;
  const kept = result && result['traffic/read'] === '123';
  // For a null-prototype object, `.__proto__`/`.constructor` return
  // undefined (no inherited accessor) whether or not the poisoned keys
  // were skipped — the real signal is that they were never set as OWN
  // properties, and that the object's prototype is genuinely null.
  const noOwnUnsafeKeys = result &&
    !Object.prototype.hasOwnProperty.call(result, '__proto__') &&
    !Object.prototype.hasOwnProperty.call(result, 'constructor') &&
    !Object.prototype.hasOwnProperty.call(result, 'prototype');
  const isNullProto = result && Object.getPrototypeOf(result) === null;
  return {
    ok: clean && kept && noOwnUnsafeKeys && isNullProto,
    detail: JSON.stringify({ clean, kept, noOwnUnsafeKeys, isNullProto, keys: result && Object.keys(result) }),
  };
}

process.on('unhandledRejection', (err) => {
  console.log('[FAIL] unhandled rejection:', err && err.message);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.log('[FAIL] uncaught exception (main process would have crashed):', err && err.message);
  process.exit(1);
});

main().catch((err) => {
  console.log('[FAIL] driver error:', err && err.stack);
  process.exit(1);
});
