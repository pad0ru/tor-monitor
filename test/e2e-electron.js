'use strict';
/**
 * End-to-end UI test — run with:  npx electron test/e2e-electron.js
 * (on Linux/WSL add --no-sandbox)
 *
 * Loads the REAL electron-app (main.js + preload + renderer) inside real
 * Electron, spawns the mock control port + relay agent and an in-process
 * mock SSH server, then drives the connection form and terminal via
 * executeJavaScript and reports what the UI shows.
 */
const path = require('path');
const net = require('net');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');
const { TEST_DIR, REPO, ensureHostKey, startAgentStack } = require('./setup');

const APP_DIR = path.join(REPO, 'electron-app');
const ssh2 = require(path.join(APP_DIR, 'node_modules', 'ssh2'));

const SSH_PORT = 12223;
const CONTROL_PORT = 19072;
const AGENT_HTTP_PORT = 15074;
const LOCAL_PORT = 15075;

// Fresh TOFU state per run (the real app stores pins in userData).
try { fs.unlinkSync(path.join(app.getPath('userData'), 'known_hosts.json')); } catch (_e) {}

let failures = 0;
function check(name, cond, extra) {
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// mock SSH server (same behavior as the integration test one)
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
      session.on('shell', (accept) => {
        const stream = accept();
        stream.write('E2E-SHELL-READY$ ');
        stream.on('data', (d) => stream.write(d));
        stream.on('error', () => {});
      });
    });
  });
});
sshServer.listen(SSH_PORT, '127.0.0.1');

// load the real app (registers IPC handlers, opens the window on ready)
require(path.join(APP_DIR, 'main.js'));

const consoleErrors = [];
app.on('web-contents-created', (_e, wc) => {
  wc.on('console-message', (_evt, level, message) => {
    if (level >= 2) consoleErrors.push(message);
  });
});

let stack = null;

app.whenReady().then(async () => {
  stack = await startAgentStack({ controlPort: CONTROL_PORT, agentPort: AGENT_HTTP_PORT });
  await sleep(2500); // let the window load
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) {
    check('window created', false);
    finish();
    return;
  }
  check('window created', true);
  const js = (code) => win.webContents.executeJavaScript(code, true);

  const libs = await js(`({
    chart: typeof Chart, term: typeof Terminal, fit: typeof FitAddon,
    monitorApi: typeof window.monitor, termApi: typeof window.terminal,
    chartObj: typeof chart
  })`);
  check('renderer libs + preload APIs loaded',
    libs.chart === 'function' && libs.term === 'function' && libs.fit === 'object' &&
    libs.monitorApi === 'object' && libs.termApi === 'object' && libs.chartObj === 'object',
    JSON.stringify(libs));

  await js(`
    document.getElementById('sshHost').value = '127.0.0.1';
    document.getElementById('sshPort').value = '${SSH_PORT}';
    document.getElementById('sshUsername').value = 'testuser';
    document.getElementById('sshPassword').value = 'testpass';
    document.getElementById('agentPort').value = '${AGENT_HTTP_PORT}';
    document.getElementById('localPort').value = '${LOCAL_PORT}';
    document.getElementById('fingerprint').value = '';
    document.getElementById('connectBtn').click();
    'clicked'
  `);
  await sleep(5000);

  const state = await js(`({
    status: document.getElementById('sshStatus').textContent,
    err: document.getElementById('connError').textContent,
    uptime: document.getElementById('statUptime').textContent,
    readRate: document.getElementById('statReadRate').textContent,
    chartPoints: chart.data.datasets[0].data.length,
    panelsVisible: !document.getElementById('status-panel').classList.contains('hidden')
  })`);
  check('UI connected via real SSH tunnel', state.status === 'connected', JSON.stringify(state));
  check('live stats rendered', /\d+d \d+h \d+m/.test(state.uptime) && /KB\/s/.test(state.readRate),
    `uptime=${state.uptime} read=${state.readRate}`);
  check('chart accumulating points', state.chartPoints >= 1, `points=${state.chartPoints}`);

  await js(`document.getElementById('openTerminalBtn').click(); 'ok'`);
  await sleep(2500);
  const termState = await js(`({
    hasXterm: !!document.querySelector('#terminalHost .xterm'),
    text: (() => {
      const b = term.buffer.active; let out = '';
      for (let i = 0; i < Math.min(b.length, 10); i++) out += b.getLine(i).translateToString(true) + '\\n';
      return out;
    })()
  })`);
  check('xterm rendered in DOM', termState.hasXterm);
  check('shell prompt visible in terminal', termState.text.includes('E2E-SHELL-READY$'),
    JSON.stringify(termState.text.trim().slice(0, 60)));

  // type into the terminal through xterm's input path
  await js(`term.input ? term.input('echo-test\\r') : window.terminal.sendInput('echo-test\\r'); 'sent'`);
  await sleep(1500);
  const echoed = await js(`(() => {
    const b = term.buffer.active; let out = '';
    for (let i = 0; i < Math.min(b.length, 10); i++) out += b.getLine(i).translateToString(true) + '\\n';
    return out;
  })()`);
  check('terminal round-trip (input echoed by shell)', echoed.includes('echo-test'),
    JSON.stringify(echoed.trim().slice(0, 80)));

  await js(`document.getElementById('disconnectBtn').click(); 'ok'`);
  await sleep(1500);
  const post = await js(`({
    status: document.getElementById('sshStatus').textContent,
    connEnabled: !document.getElementById('connectBtn').disabled
  })`);
  check('disconnect updates UI', post.status === 'disconnected' && post.connEnabled, JSON.stringify(post));

  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.join(' | ').slice(0, 200));

  finish();
});

function finish() {
  console.log(failures === 0 ? '\nE2E ALL PASSED' : `\n${failures} E2E FAILURE(S)`);
  if (stack) stack.stop();
  app.exit(failures === 0 ? 0 : 1);
}
