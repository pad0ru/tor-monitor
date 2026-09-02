'use strict';
/**
 * Real-Electron security verification for the v0.3.1 hardening pass —
 * run with:  npx electron test/security-e2e.js  (add --no-sandbox on
 * Linux/WSL)
 *
 * Covers what can only be tested inside a real BrowserWindow/webContents:
 *
 *   Safeguard 1 — Electron lockdown: the global web-contents-created
 *   handler (popup denial, off-file:// navigation denial, <webview>
 *   denial, permission-request denial) and the explicit sandbox:true.
 *
 *   Safeguard 3 (good/alternate flow) — the task manager's pid+name
 *   selection identity, exercised two ways:
 *     (a) against the real connected task manager window, ending real
 *         child processes through the actual UI/IPC/SSH path;
 *     (b) against a second, mock-driven task manager window (real
 *         taskmanager.html/.js — unmodified production files — fed
 *         scripted snapshots over a throwaway IPC channel) to
 *         deterministically simulate pid reuse, which the OS won't
 *         reliably reproduce inside a short test run.
 *
 * The bad-flow / IPC-boundary tests for kill validation (PID 1, non-
 * integer pid, signal coercion, etc.) live in
 * test/security-hardening.test.js since they don't need a real window.
 */
const path = require('path');
const net = require('net');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { app, BrowserWindow, ipcMain } = require('electron');
const { TEST_DIR, REPO, ensureHostKey, startAgentStack } = require('./setup');

const APP_DIR = path.join(REPO, 'electron-app');
const ssh2 = require(path.join(APP_DIR, 'node_modules', 'ssh2'));

const SSH_PORT = 12241;
const CONTROL_PORT = 19073;
const AGENT_HTTP_PORT = 15081;
const LOCAL_PORT = 15082;

try { fs.unlinkSync(path.join(app.getPath('userData'), 'known_hosts.json')); } catch (_e) {}

let failures = 0;
let passed = 0;
function check(name, cond, extra) {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
  if (cond) passed++; else failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mock sshd: password auth, tcpip forwarding (for agent stats), and exec
// (runs the command for real, so the task manager sees real /proc data)
const sshServer = new ssh2.Server({ hostKeys: [ensureHostKey('ssh_host_key.pem')] }, (client) => {
  client.on('error', () => {});
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'testuser' && ctx.password === 'testpass') ctx.accept();
    else ctx.reject(['password']);
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
      session.on('pty', (a) => a && a());
      session.on('window-change', (a) => a && a());
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
        stream.write('SEC-E2E-SHELL$ ');
        stream.on('data', (d) => stream.write(d));
        stream.on('error', () => {});
      });
    });
  });
});
sshServer.listen(SSH_PORT, '127.0.0.1');

// load the real app (registers ipcMain handlers + the security handler)
require(path.join(APP_DIR, 'main.js'));

// --- mock task manager preload + IPC, for deterministic selection tests ---
const mockPreloadPath = path.join(TEST_DIR, 'security-tm-mock-preload.js');
fs.writeFileSync(mockPreloadPath, `
'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sysinfo', {
  processes: () => ipcRenderer.invoke('sec-test:processes'),
  kill: (pid, signal) => ipcRenderer.invoke('sec-test:kill', { pid, signal }),
  specs: () => Promise.resolve({ ok: false, error: 'unused in this harness' }),
  openTaskManager: () => Promise.resolve({ ok: true }),
  openSpecs: () => Promise.resolve({ ok: true }),
});
`);
let mockQueue = [];
const mockKillCalls = [];
ipcMain.handle('sec-test:processes', async () => {
  if (mockQueue.length > 1) return mockQueue.shift();
  return mockQueue[0] || { ok: false, error: 'no mock data queued' };
});
ipcMain.handle('sec-test:kill', async (_e, { pid, signal }) => {
  mockKillCalls.push({ pid, signal });
  return { ok: true, pid, signal };
});
function baseSnapshot(processesList, overrides) {
  return {
    ok: true,
    timestamp: Date.now(),
    ncpu: 4,
    cpuPercent: 12.3,
    mem: { totalBytes: 4e9, availableBytes: 2e9, usedBytes: 2e9, swapTotalBytes: 0, swapUsedBytes: 0 },
    load: [0.1, 0.2, 0.3],
    uptimeSeconds: 3600,
    processes: processesList,
    ...overrides,
  };
}
function proc(pid, name, over) {
  return { pid, ppid: 1, name, user: 'testuser', args: name + ' --flag', state: 'S',
    threads: 1, rssBytes: 1024 * 1024, cpuPercent: 1.0, memPercent: 1.0, ...over };
}

let stack = null;

app.whenReady().then(async () => {
  stack = await startAgentStack({ controlPort: CONTROL_PORT, agentPort: AGENT_HTTP_PORT });
  await sleep(2500);
  const win = BrowserWindow.getAllWindows()[0];
  const js = (code) => win.webContents.executeJavaScript(code, true);

  await js(`
    document.getElementById('sshHost').value = '127.0.0.1';
    document.getElementById('sshPort').value = '${SSH_PORT}';
    document.getElementById('sshUsername').value = 'testuser';
    document.getElementById('sshPassword').value = 'testpass';
    document.getElementById('agentPort').value = '${AGENT_HTTP_PORT}';
    document.getElementById('localPort').value = '${LOCAL_PORT}';
    document.getElementById('connectBtn').click();
    'clicked'
  `);
  await sleep(4000);
  const status = await js(`document.getElementById('sshStatus').textContent`);
  check('setup: connected to mock relay', status === 'connected', status);

  // ===================================================================
  // Safeguard 1 — GOOD FLOW
  // ===================================================================
  console.log('\n--- Safeguard 1: good flow ---');
  check('G1: main window created', !!win);

  await js(`document.getElementById('openTaskManagerBtn').click(); document.getElementById('openSpecsBtn').click(); 'ok'`);
  await sleep(3500);
  let tmWin = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Task manager');
  let spWin = BrowserWindow.getAllWindows().find((w) => w.getTitle() === 'Server specs');
  check('G2: task manager window opens', !!tmWin);
  check('G3: server specs window opens', !!spWin);

  await js(`document.getElementById('openTerminalBtn').click(); 'ok'`);
  await sleep(2200);
  const termText = await js(`(() => { const b = term.buffer.active; let out = '';
    for (let i = 0; i < Math.min(b.length, 5); i++) out += b.getLine(i).translateToString(true);
    return out; })()`);
  check('G4: terminal still opens with a real shell prompt', /SEC-E2E-SHELL\$/.test(termText), termText.slice(0, 60));

  check('G5: SSH status reflects a connected session', status === 'connected');

  const beforeReopen = BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Task manager').length;
  await js(`document.getElementById('openTaskManagerBtn').click(); 'ok'`);
  await sleep(500);
  const afterReopen = BrowserWindow.getAllWindows().filter((w) => w.getTitle() === 'Task manager').length;
  check('G6: reopening task manager focuses the existing window, does not duplicate',
    beforeReopen === 1 && afterReopen === 1, `before=${beforeReopen} after=${afterReopen}`);

  // ===================================================================
  // Safeguard 1 — ALTERNATE FLOW
  // ===================================================================
  console.log('\n--- Safeguard 1: alternate flow ---');
  const winCountBase = BrowserWindow.getAllWindows().length;

  const openAbout = await js(`window.open('about:blank') === null`);
  check('A1: window.open("about:blank") denied', openAbout === true);

  const openJs = await js(`window.open('javascript:void(0)') === null`);
  check('A2: window.open("javascript:...") denied', openJs === true);

  const openRel = await js(`window.open('some-other-page.html') === null`);
  check('A3: window.open() with a relative path denied', openRel === true);

  const openData = await js(`window.open('data:text/html,hi') === null`);
  check('A4: window.open("data:...") denied', openData === true);

  const openBlob = await js(`window.open('blob:null/00000000-0000-0000-0000-000000000000') === null`);
  check('A5: window.open("blob:...") denied', openBlob === true);
  check('  (no popups created across A1-A5)', BrowserWindow.getAllWindows().length === winCountBase,
    `count=${BrowserWindow.getAllWindows().length} base=${winCountBase}`);

  // positive control: same-app file:// top-level navigation IS allowed
  {
    let navigatedTo = null;
    const onNav = (_e, url) => { navigatedTo = url; };
    win.webContents.once('did-navigate', onNav);
    const specsPath = path.join(APP_DIR, 'renderer', 'specs.html').split(path.sep).join('/');
    await js(`window.location.href = 'file://${specsPath}'; 'navigating'`);
    await sleep(900);
    check('A6: same-app file:// top-level navigation is allowed (positive control)',
      !!navigatedTo && navigatedTo.endsWith('specs.html'), navigatedTo);
    await win.loadFile(path.join(APP_DIR, 'renderer', 'index.html'));
    await sleep(1200);
    const restored = await js(`typeof window.monitor`);
    check('  (main window restored for the remaining tests)', restored === 'object', restored);
  }

  const notifPerm = await js(`Notification.requestPermission()`);
  check('A7: Notification permission is denied', notifPerm === 'denied', notifPerm);

  const mediaResult = await js(`
    navigator.mediaDevices.getUserMedia({ video: true })
      .then(() => 'granted')
      .catch((e) => e.name)
  `);
  check('A8: getUserMedia (camera) permission is denied', mediaResult !== 'granted', mediaResult);

  const geoResult = await js(`
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 3000);
      navigator.geolocation.getCurrentPosition(
        () => { clearTimeout(timer); resolve('granted'); },
        (err) => { clearTimeout(timer); resolve('denied:' + err.code); }
      );
    })
  `);
  check('A9: geolocation permission is denied', geoResult !== 'granted', geoResult);

  const noNodeGlobals = await js(`({ proc: typeof process, req: typeof require, mod: typeof module })`);
  check('A10: renderer has no Node globals under sandbox:true',
    noNodeGlobals.proc === 'undefined' && noNodeGlobals.req === 'undefined' && noNodeGlobals.mod === 'undefined',
    JSON.stringify(noNodeGlobals));

  const bridgeApis = await js(`({
    monitor: typeof window.monitor, terminal: typeof window.terminal,
    sysinfo: typeof window.sysinfo, clipboard: typeof window.clipboard
  })`);
  check('A11: all contextBridge APIs still work under sandbox:true',
    Object.values(bridgeApis).every((t) => t === 'object'), JSON.stringify(bridgeApis));

  const webviewResult = await js(`(() => {
    const before = document.querySelectorAll('*').length;
    const wv = document.createElement('webview');
    wv.src = 'https://example.com/';
    document.body.appendChild(wv);
    return { tagName: wv.tagName, isWebview: wv.constructor.name };
  })()`);
  await sleep(500);
  check('A12: <webview> element does not spawn an extra window/webContents',
    BrowserWindow.getAllWindows().length === winCountBase, `count=${BrowserWindow.getAllWindows().length}`);

  // ===================================================================
  // Safeguard 1 — BAD FLOW
  // ===================================================================
  console.log('\n--- Safeguard 1: bad flow ---');
  const winsBeforeLoop = BrowserWindow.getAllWindows().length;
  await js(`for (let i = 0; i < 5; i++) window.open('https://example.com/' + i); 'looped'`);
  await sleep(500);
  check('B1: rapid window.open() loop (5x) creates zero popups',
    BrowserWindow.getAllWindows().length === winsBeforeLoop, `count=${BrowserWindow.getAllWindows().length}`);

  const anchorResult = await js(`(() => {
    const before = BrowserWindow_LEN;
    const a = document.createElement('a');
    a.href = 'https://example.com/'; a.target = '_blank'; a.textContent = 'x';
    document.body.appendChild(a); a.click(); a.remove();
    return 'clicked';
  })()`.replace('BrowserWindow_LEN', '0'));
  await sleep(500);
  check('B2: <a target=_blank> click to an external URL creates zero popups',
    BrowserWindow.getAllWindows().length === winsBeforeLoop, `count=${BrowserWindow.getAllWindows().length}`);

  {
    let blockedNav = true;
    win.webContents.once('did-navigate', () => { blockedNav = false; });
    await js(`window.location.replace('https://example.com/'); 'x'`);
    await sleep(700);
    const proto1 = await js(`window.location.protocol`).catch(() => 'file:');
    check('B3: location.replace() to an external URL is blocked', blockedNav && proto1 === 'file:', proto1);
  }
  {
    let blockedNav = true;
    win.webContents.once('did-navigate', () => { blockedNav = false; });
    await js(`window.location.assign('https://example.com/'); 'x'`);
    await sleep(700);
    const proto2 = await js(`window.location.protocol`).catch(() => 'file:');
    check('B4: location.assign() to an external URL is blocked', blockedNav && proto2 === 'file:', proto2);
  }
  {
    let blockedNav = true;
    win.webContents.once('did-navigate', () => { blockedNav = false; });
    await js(`(() => {
      const f = document.createElement('form');
      f.action = 'https://example.com/submit'; f.method = 'POST';
      document.body.appendChild(f); f.submit();
      return 'submitted';
    })()`);
    await sleep(700);
    const proto3 = await js(`window.location.protocol`).catch(() => 'file:');
    check('B5: external <form> submission is blocked', blockedNav && proto3 === 'file:', proto3);
  }
  {
    let blockedNav = true;
    win.webContents.once('did-navigate', () => { blockedNav = false; });
    await js(`(() => {
      const m = document.createElement('meta');
      m.httpEquiv = 'refresh'; m.content = '0;url=https://example.com/';
      document.head.appendChild(m);
      return 'injected';
    })()`);
    await sleep(1200);
    const proto4 = await js(`window.location.protocol`).catch(() => 'file:');
    check('B6: injected <meta refresh> to an external URL is blocked', blockedNav && proto4 === 'file:', proto4);
  }
  {
    let blockedNav = true;
    win.webContents.once('did-navigate', () => { blockedNav = false; });
    await js(`window.top.location.href = 'https://example.com/'; 'x'`);
    await sleep(700);
    const proto5 = await js(`window.location.protocol`).catch(() => 'file:');
    check('B7: window.top.location assignment to an external URL is blocked', blockedNav && proto5 === 'file:', proto5);
  }

  // sanity: the app is still fully alive after the bad-flow barrage
  const aliveCheck = await js(`typeof window.monitor === 'object' && document.getElementById('connectBtn') !== null`);
  check('  (app remains fully functional after the navigation attack barrage)', aliveCheck === true);

  // ===================================================================
  // Safeguard 3 — GOOD FLOW (real connected task manager)
  // ===================================================================
  console.log('\n--- Safeguard 3: good flow (real task manager) ---');
  const tjs = (code) => tmWin.webContents.executeJavaScript(code, true);
  // Pause the window's own background auto-poll (default 2s interval,
  // running since it opened) so every check below is driven only by our
  // explicit refresh() calls — otherwise a background tick can race
  // with (and overwrite) a status message we're about to assert on.
  await tjs(`document.getElementById('interval').value = '0';
             document.getElementById('interval').dispatchEvent(new Event('change')); 'paused'`);
  await tjs(`refresh()`);
  await sleep(500);

  const v1 = spawn('sleep', ['600'], { stdio: 'ignore' });
  await sleep(2200);
  await tjs(`refresh()`);
  const sel1 = await tjs(`(() => {
    document.getElementById('filter').value = '${v1.pid}';
    document.getElementById('filter').dispatchEvent(new Event('input'));
    const row = document.querySelector('#procBody tr');
    if (row) row.click();
    return { found: !!row, selectedClass: document.querySelectorAll('#procBody tr.selected').length,
             endEnabled: !document.getElementById('endBtn').disabled };
  })()`);
  check('G7: selecting a row applies .selected and enables End process',
    sel1.found && sel1.selectedClass === 1 && sel1.endEnabled, JSON.stringify(sel1));

  const desel = await tjs(`(() => {
    document.querySelector('#procBody tr').click();
    return { selectedClass: document.querySelectorAll('#procBody tr.selected').length,
             endEnabled: !document.getElementById('endBtn').disabled };
  })()`);
  check('G8: clicking the same row again deselects it', desel.selectedClass === 0 && !desel.endEnabled, JSON.stringify(desel));

  // re-select v1, then End it (TERM) for real
  await tjs(`document.querySelector('#procBody tr').click(); 'reselected'`);
  const v1ExitPromise = new Promise((res) => v1.on('exit', (_c, sig) => res(sig)));
  await tjs(`document.getElementById('endBtn').click(); document.getElementById('confirmYes').click(); 'ended'`);
  const v1Sig = await Promise.race([v1ExitPromise, sleep(3000).then(() => 'timeout')]);
  await sleep(2600);
  await tjs(`refresh()`);
  const afterTerm = await tjs(`({
    rows: document.querySelectorAll('#procBody tr').length,
    selectedClass: document.querySelectorAll('#procBody tr.selected').length,
    endEnabled: !document.getElementById('endBtn').disabled
  })`);
  check('G9: End process (TERM) actually ends the process, row removed, selection cleared',
    v1Sig === 'SIGTERM' && afterTerm.rows === 0 && afterTerm.selectedClass === 0 && !afterTerm.endEnabled,
    JSON.stringify({ v1Sig, afterTerm }));

  // Force kill on a fresh victim
  await tjs(`document.getElementById('filter').value = ''; document.getElementById('filter').dispatchEvent(new Event('input')); 'cleared'`);
  const v2 = spawn('sleep', ['600'], { stdio: 'ignore' });
  await sleep(2200);
  await tjs(`refresh()`);
  const v2ExitPromise = new Promise((res) => v2.on('exit', (_c, sig) => res(sig)));
  await tjs(`
    document.getElementById('filter').value = '${v2.pid}';
    document.getElementById('filter').dispatchEvent(new Event('input'));
    document.querySelector('#procBody tr').click();
    document.getElementById('killBtn').click();
    document.getElementById('confirmYes').click();
    'killed'
  `);
  const v2Sig = await Promise.race([v2ExitPromise, sleep(3000).then(() => 'timeout')]);
  await sleep(2600);
  await tjs(`refresh()`);
  const afterKill = await tjs(`({
    rows: document.querySelectorAll('#procBody tr').length,
    selectedClass: document.querySelectorAll('#procBody tr.selected').length
  })`);
  check('G10: Force kill (KILL) actually kills the process, row removed, selection cleared',
    v2Sig === 'SIGKILL' && afterKill.rows === 0 && afterKill.selectedClass === 0,
    JSON.stringify({ v2Sig, afterKill }));

  // Cancel leaves the process alone and the selection intact
  await tjs(`document.getElementById('filter').value = ''; document.getElementById('filter').dispatchEvent(new Event('input')); 'cleared'`);
  const v3 = spawn('sleep', ['600'], { stdio: 'ignore' });
  await sleep(2200);
  await tjs(`refresh()`);
  const cancelResult = await tjs(`
    document.getElementById('filter').value = '${v3.pid}';
    document.getElementById('filter').dispatchEvent(new Event('input'));
    document.querySelector('#procBody tr').click();
    document.getElementById('endBtn').click();
    const shownBefore = !document.getElementById('confirmBar').classList.contains('hidden');
    document.getElementById('confirmNo').click();
    ({ shownBefore, hiddenAfter: document.getElementById('confirmBar').classList.contains('hidden'),
       stillSelected: document.querySelectorAll('#procBody tr.selected').length })
  `);
  const v3Alive = v3.exitCode === null && v3.killed === false;
  check('G11: Cancel on the confirm bar does not kill the process, selection retained',
    cancelResult.shownBefore && cancelResult.hiddenAfter && cancelResult.stillSelected === 1 && v3Alive,
    JSON.stringify({ cancelResult, v3Alive }));
  try { process.kill(v3.pid); } catch (_e) {}
  await tjs(`document.getElementById('filter').value = ''; document.getElementById('filter').dispatchEvent(new Event('input')); 'cleared'`);

  // ===================================================================
  // Safeguard 3 — ALTERNATE FLOW, part 1 (real task manager)
  // ===================================================================
  console.log('\n--- Safeguard 3: alternate flow, part 1 (real task manager) ---');
  const v4 = spawn('sleep', ['600'], { stdio: 'ignore' });
  await sleep(2200);
  await tjs(`refresh()`);
  const filterHide = await tjs(`
    document.getElementById('filter').value = '${v4.pid}';
    document.getElementById('filter').dispatchEvent(new Event('input'));
    document.querySelector('#procBody tr').click();
    document.getElementById('filter').value = 'zzz-no-such-process-zzz';
    document.getElementById('filter').dispatchEvent(new Event('input'));
    const rowsWhileHidden = document.querySelectorAll('#procBody tr').length;
    document.getElementById('filter').value = '${v4.pid}';
    document.getElementById('filter').dispatchEvent(new Event('input'));
    ({ rowsWhileHidden, stillSelectedAfterClear: document.querySelectorAll('#procBody tr.selected').length,
       endStillEnabled: !document.getElementById('endBtn').disabled })
  `);
  check('A13: selection survives being filtered out of view, reappears when the filter matches again',
    filterHide.rowsWhileHidden === 0 && filterHide.stillSelectedAfterClear === 1 && filterHide.endStillEnabled,
    JSON.stringify(filterHide));

  try { process.kill(v4.pid); } catch (_e) {}
  await sleep(2600);
  await tjs(`refresh()`);
  const afterExternalExit = await tjs(`({
    rows: document.querySelectorAll('#procBody tr').length,
    selectedClass: document.querySelectorAll('#procBody tr.selected').length,
    endEnabled: !document.getElementById('endBtn').disabled
  })`);
  check('A14: selection auto-clears when the process exits on its own (not via the UI)',
    afterExternalExit.rows === 0 && afterExternalExit.selectedClass === 0 && !afterExternalExit.endEnabled,
    JSON.stringify(afterExternalExit));

  await tjs(`document.getElementById('filter').value = ''; document.getElementById('filter').dispatchEvent(new Event('input')); 'cleared'`);
  const v5 = spawn('sleep', ['600'], { stdio: 'ignore' });
  await sleep(2200);
  await tjs(`refresh()`);
  await tjs(`
    document.getElementById('filter').value = '${v5.pid}';
    document.getElementById('filter').dispatchEvent(new Event('input'));
    document.querySelector('#procBody tr').click();
    'selected'
  `);
  try { process.kill(v5.pid); } catch (_e) {} // exits between selection and the click below, no re-poll yet
  // The confirm bar uses the LAST-KNOWN snapshot (renderTable only
  // re-syncs selection on the next poll), so it legitimately still
  // shows here even though the process just died — that's expected,
  // not a bug. The real race surfaces one step later: confirming sends
  // a kill for a pid the OS says no longer exists, and the app must
  // report that cleanly instead of crashing or showing a raw IPC error.
  const staleFlow = await tjs(`
    document.getElementById('endBtn').click();
    const confirmShown = !document.getElementById('confirmBar').classList.contains('hidden');
    document.getElementById('confirmYes').click();
    ({ confirmShown })
  `);
  await sleep(1500);
  const staleResult = await tjs(`({
    statusText: document.getElementById('status').textContent,
    warnClass: document.getElementById('status').classList.contains('warn')
  })`);
  check('A15: confirming a kill on a since-exited process reports "no longer exists" cleanly (no crash)',
    staleFlow.confirmShown && /no longer exists/i.test(staleResult.statusText) && staleResult.warnClass,
    JSON.stringify({ staleFlow, staleResult }));
  await sleep(2600);
  const stillAlive = await tjs(`typeof window.sysinfo === 'object' && document.getElementById('endBtn') !== null`);
  check('  (task manager window is still responsive after the stale-confirm race)', stillAlive === true);

  // ===================================================================
  // Safeguard 3 — ALTERNATE FLOW, part 2 (mock-driven task manager,
  // exercising the real production taskmanager.html/.js unmodified)
  // ===================================================================
  console.log('\n--- Safeguard 3: alternate flow, part 2 (mock-driven, deterministic pid reuse) ---');
  let mockWin = new BrowserWindow({
    width: 900, height: 600, show: false,
    webPreferences: { preload: mockPreloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await mockWin.loadFile(path.join(APP_DIR, 'renderer', 'taskmanager.html'));
  await sleep(600);
  const mjs = (code) => mockWin.webContents.executeJavaScript(code, true);

  // THE CORE FIX: pid 7777 is 'legit-proc', gets selected; next snapshot
  // shows pid 7777 as a DIFFERENT process 'imposter-proc' (simulating
  // the kernel recycling the pid) — selection must clear, not follow.
  mockQueue = [baseSnapshot([proc(7777, 'legit-proc')])];
  await mjs(`refresh()`);
  const beforeSwap = await mjs(`(() => {
    document.querySelector('#procBody tr').click();
    return { selected: document.querySelectorAll('#procBody tr.selected').length, endEnabled: !document.getElementById('endBtn').disabled };
  })()`);
  mockQueue = [baseSnapshot([proc(7777, 'imposter-proc')])];
  await mjs(`refresh()`);
  const afterSwap = await mjs(`({
    selected: document.querySelectorAll('#procBody tr.selected').length,
    endEnabled: !document.getElementById('endBtn').disabled,
    visiblePid: document.querySelector('#procBody tr td')?.textContent
  })`);
  check('A16 (CORE FIX): pid recycled by a differently-named process clears the selection instead of following it',
    beforeSwap.selected === 1 && beforeSwap.endEnabled &&
    afterSwap.selected === 0 && !afterSwap.endEnabled && afterSwap.visiblePid === '7777',
    JSON.stringify({ beforeSwap, afterSwap }));

  // Positive control: same pid, SAME name across polls (an ordinary
  // ongoing process, not a reuse) — selection must NOT be dropped.
  await mockWin.loadFile(path.join(APP_DIR, 'renderer', 'taskmanager.html'));
  await sleep(600);
  mockQueue = [baseSnapshot([proc(8888, 'steady-proc', { cpuPercent: 1.0 })])];
  await mjs(`refresh()`);
  await mjs(`document.querySelector('#procBody tr').click(); 'selected'`);
  mockQueue = [baseSnapshot([proc(8888, 'steady-proc', { cpuPercent: 4.2 })])]; // same identity, cpu changed
  await mjs(`refresh()`);
  const steadyState = await mjs(`({
    selected: document.querySelectorAll('#procBody tr.selected').length,
    endEnabled: !document.getElementById('endBtn').disabled
  })`);
  check('A17 (positive control): same pid + same name across polls keeps the selection (fix is not overly aggressive)',
    steadyState.selected === 1 && steadyState.endEnabled, JSON.stringify(steadyState));

  // rapid re-selection across three different rows: only the last one wins
  await mockWin.loadFile(path.join(APP_DIR, 'renderer', 'taskmanager.html'));
  await sleep(600);
  mockQueue = [baseSnapshot([proc(101, 'proc-a'), proc(102, 'proc-b'), proc(103, 'proc-c')])];
  await mjs(`refresh()`);
  const rapidResult = await mjs(`(() => {
    // renderTable() replaces the whole <tbody> on every click, so each
    // click must re-query the LIVE DOM — a row reference captured
    // before an earlier click is detached afterward and its click()
    // never bubbles to procBody's delegated listener.
    const clickPid = (pid) => document.querySelector('#procBody tr[data-pid="' + pid + '"]').click();
    clickPid('101');
    clickPid('102');
    clickPid('103');
    const selected = [...document.querySelectorAll('#procBody tr.selected')].map((r) => r.dataset.pid);
    return { count: selected.length, pids: selected };
  })()`);
  check('A18: rapid re-selection across three rows leaves only the last one selected',
    rapidResult.count === 1 && rapidResult.pids[0] === '103', JSON.stringify(rapidResult));

  // documented known limitation: pid reused by a process that happens
  // to share the SAME name — the fix can't distinguish this case
  await mockWin.loadFile(path.join(APP_DIR, 'renderer', 'taskmanager.html'));
  await sleep(600);
  mockQueue = [baseSnapshot([proc(9999, 'shared-name', { rssBytes: 1000 })])];
  await mjs(`refresh()`);
  await mjs(`document.querySelector('#procBody tr').click(); 'selected'`);
  mockQueue = [baseSnapshot([proc(9999, 'shared-name', { rssBytes: 999999 })])]; // "different" process, same name
  await mjs(`refresh()`);
  const sameNameReuse = await mjs(`({ selected: document.querySelectorAll('#procBody tr.selected').length })`);
  check('A19 (documented limitation): pid reused with an IDENTICAL name is indistinguishable and stays selected',
    sameNameReuse.selected === 1, JSON.stringify(sameNameReuse));

  mockWin.close();

  console.log(`\n${passed} passed, ${failures} failed (${passed + failures} total)`);
  finish();
});

function finish() {
  console.log(failures === 0 ? '\nALL SECURITY E2E TESTS PASSED' : `\n${failures} SECURITY E2E TEST(S) FAILED`);
  try { fs.unlinkSync(mockPreloadPath); } catch (_e) {}
  if (stack) stack.stop();
  app.exit(failures === 0 ? 0 : 1);
}

process.on('unhandledRejection', (err) => {
  console.log('[FAIL] unhandled rejection:', err && err.message);
  try { fs.unlinkSync(mockPreloadPath); } catch (_e) {}
  if (stack) stack.stop();
  app.exit(1);
});
