'use strict';

const { app, BrowserWindow, ipcMain, clipboard } = require('electron');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const fs = require('fs');
const { Client } = require('ssh2');

let mainWindow = null;
let sshClient = null;
let localServer = null;
let agentPollTimer = null;
let onionooPollTimer = null;
let terminalStream = null;

// Reconnect state. currentCfg (incl. credentials) is held in memory for
// the lifetime of the session so we can re-dial after a drop; it is
// cleared on explicit disconnect.
let currentCfg = null;
let userDisconnected = false;
let reconnectTimer = null;
let reconnectDelayMs = 2000;
const RECONNECT_DELAY_MAX_MS = 30000;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    closeToolWindows();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  fullTeardown();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function closeTerminalStream() {
  if (!terminalStream) return;
  const stream = terminalStream;
  terminalStream = null;
  stream.removeAllListeners();
  stream.on('error', () => {});
  stream.end();
  send('terminal-data', '\r\n[session closed]\r\n');
  send('terminal-closed', { timestamp: Date.now() });
}

// Tears down the live connection pieces but keeps currentCfg so a
// reconnect can reuse it.
function teardownConnection() {
  if (agentPollTimer) clearInterval(agentPollTimer);
  if (onionooPollTimer) clearInterval(onionooPollTimer);
  agentPollTimer = null;
  onionooPollTimer = null;
  closeTerminalStream();
  resetCpuSamples();
  if (localServer) {
    localServer.close();
    localServer = null;
  }
  if (sshClient) {
    sshClient.removeAllListeners();
    sshClient.on('error', () => {}); // swallow late errors from the dying client
    sshClient.end();
    sshClient = null;
  }
}

function fullTeardown() {
  userDisconnected = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  teardownConnection();
  currentCfg = null;
}

// Trust-on-first-use host key pinning. ssh2 does not verify host keys by
// default, which would let a MITM harvest the SSH password. The first
// successful connection stores the server's key hash; later connections
// must match it.
function knownHostsPath() {
  return path.join(app.getPath('userData'), 'known_hosts.json');
}

function loadKnownHosts() {
  try {
    return JSON.parse(fs.readFileSync(knownHostsPath(), 'utf8'));
  } catch (_e) {
    return {};
  }
}

// Returns null if ok, or an error message string on mismatch.
function checkHostKey(host, port, sha256hash) {
  const id = `${host}:${port}`;
  const known = loadKnownHosts();
  if (!(id in known)) {
    known[id] = sha256hash;
    try {
      fs.writeFileSync(knownHostsPath(), JSON.stringify(known, null, 2));
    } catch (err) {
      console.error('could not save known host key:', err.message);
    }
    return null; // first use: trust and pin
  }
  if (known[id] === sha256hash) return null;
  return (
    `host key for ${id} changed (expected SHA256:${known[id]}, got SHA256:${sha256hash}). ` +
    `Possible man-in-the-middle. If the server key really changed, delete ${knownHostsPath()} and reconnect.`
  );
}

// Sets up: SSH connection -> local TCP server that forwards each
// connection through the SSH tunnel to the agent's HTTP port on the
// relay machine. The main process then just does plain http.get()
// against 127.0.0.1:localPort like the agent was local.
function connectTunnel(cfg) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    const settle = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    const fail = (err) => {
      // Don't leak a half-open SSH connection if setup fails after auth
      // (e.g. the local port is already in use).
      try { client.end(); } catch (_e) {}
      settle(reject, err);
    };

    client.on('ready', () => {
      const server = net.createServer((socket) => {
        socket.on('error', () => {}); // e.g. ECONNRESET from a timed-out poll
        client.forwardOut(
          '127.0.0.1',
          0,
          cfg.agentHost || '127.0.0.1',
          cfg.agentPort,
          (err, stream) => {
            if (err) {
              socket.destroy();
              return;
            }
            stream.on('error', () => {});
            socket.pipe(stream).pipe(socket);
            stream.on('close', () => socket.destroy());
            socket.on('close', () => stream.close());
          }
        );
      });
      server.on('error', fail);
      server.listen(cfg.localPort, '127.0.0.1', () => {
        sshClient = client;
        localServer = server;

        // From here on, errors/closes mean the live session dropped.
        client.on('error', (err) => {
          send('ssh-status', { state: 'error', error: friendlyConnectError(err), timestamp: Date.now() });
        });
        client.on('close', () => handleSshDrop());

        settle(resolve);
      });
    });

    client.on('error', (err) => fail(err));
    client.on('close', () => fail(new Error('SSH connection closed during setup')));

    const authOpts = {
      host: cfg.sshHost,
      port: cfg.sshPort || 22,
      username: cfg.sshUsername,
      // Detect dead connections (sleep/wifi drop) instead of hanging.
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: (hash) => {
        const problem = checkHostKey(cfg.sshHost, cfg.sshPort || 22, hash);
        if (problem) {
          fail(new Error(problem));
          return false;
        }
        return true;
      },
    };
    if (cfg.privateKeyPath) {
      try {
        authOpts.privateKey = fs.readFileSync(cfg.privateKeyPath);
      } catch (err) {
        settle(reject, new Error(`could not read private key at ${cfg.privateKeyPath}: ${err.message}`));
        return;
      }
      if (cfg.passphrase) authOpts.passphrase = cfg.passphrase;
    } else if (cfg.password) {
      authOpts.password = cfg.password;
    }

    client.connect(authOpts);
  });
}

function handleSshDrop() {
  if (userDisconnected || !currentCfg) return;
  teardownConnection();
  send('ssh-status', { state: 'reconnecting', timestamp: Date.now() });
  send('agent-stats', { ok: false, error: 'SSH connection lost, reconnecting', timestamp: Date.now() });
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer || userDisconnected || !currentCfg) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (userDisconnected || !currentCfg) return;
    try {
      await connectTunnel(currentCfg);
      reconnectDelayMs = 2000;
      startPolling(currentCfg);
      send('ssh-status', { state: 'connected', reconnected: true, timestamp: Date.now() });
    } catch (err) {
      send('ssh-status', {
        state: 'reconnecting',
        error: friendlyConnectError(err),
        nextRetryMs: reconnectDelayMs,
        timestamp: Date.now(),
      });
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, RECONNECT_DELAY_MAX_MS);
      scheduleReconnect();
    }
  }, reconnectDelayMs);
}

function startPolling(cfg) {
  if (agentPollTimer) clearInterval(agentPollTimer);
  if (onionooPollTimer) clearInterval(onionooPollTimer);

  const pollAgent = async () => {
    try {
      const stats = await fetchAgentStats(cfg.localPort, cfg.agentToken);
      send('agent-stats', stats);
    } catch (err) {
      send('agent-stats', { ok: false, error: 'unreachable: ' + err.message, timestamp: Date.now() });
    }
  };
  pollAgent();
  agentPollTimer = setInterval(pollAgent, cfg.agentPollIntervalMs || 3000);

  if (cfg.fingerprint) {
    const pollOnionoo = async () => {
      try {
        const relay = await fetchOnionoo(cfg.fingerprint);
        send('onionoo-stats', { ok: true, relay, timestamp: Date.now() });
      } catch (err) {
        send('onionoo-stats', { ok: false, error: err.message, timestamp: Date.now() });
      }
    };
    pollOnionoo();
    onionooPollTimer = setInterval(pollOnionoo, cfg.onionooPollIntervalMs || 5 * 60 * 1000);
  }
}

function fetchAgentStats(localPort, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: '127.0.0.1',
      port: localPort,
      path: '/stats',
      headers: token ? { 'x-agent-token': token } : {},
      timeout: 4000,
    };
    const req = http.get(opts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`bad response from agent (HTTP ${res.statusCode})`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function fetchOnionoo(fingerprint) {
  return new Promise((resolve, reject) => {
    if (!/^[0-9A-Fa-f]{40}$/.test(fingerprint)) {
      reject(new Error('fingerprint must be 40 hex characters'));
      return;
    }
    const url = `https://onionoo.torproject.org/details?lookup=${fingerprint.toUpperCase()}`;
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Onionoo returned HTTP ${res.statusCode}`));
          return;
        }
        try {
          const json = JSON.parse(body);
          const relay = (json.relays && json.relays[0]) || null;
          resolve(relay);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Onionoo request timed out')));
  });
}

// Translate raw ssh2/net error text into something a user can act on.
// Electron also wraps thrown IPC errors in "Error invoking remote method
// '...'": ... boilerplate, so monitor:connect returns a plain {ok, error}
// result instead of throwing, letting the renderer show a clean message.
function friendlyConnectError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/all configured authentication methods failed/i.test(msg)) {
    return 'Login failed: incorrect username or password (or key/passphrase).';
  }
  if (/ECONNREFUSED/.test(msg)) {
    return 'Could not reach that host/port — is SSH running there and is the port correct?';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) {
    return 'Host not found — check the hostname or IP address.';
  }
  if (/ETIMEDOUT|Timed out while waiting for handshake/i.test(msg)) {
    return 'Connection timed out — check the host is reachable and the port is correct.';
  }
  if (/EADDRINUSE/.test(msg)) {
    return `Local tunnel port is already in use — pick a different local port.`;
  }
  if (/man-in-the-middle/i.test(msg)) {
    return msg; // already a clear, actionable message
  }
  return msg;
}

ipcMain.handle('monitor:connect', async (_evt, cfg) => {
  fullTeardown();
  userDisconnected = false;
  try {
    await connectTunnel(cfg);
  } catch (err) {
    return { ok: false, error: friendlyConnectError(err) };
  }
  currentCfg = cfg;
  reconnectDelayMs = 2000;
  startPolling(cfg);
  send('ssh-status', { state: 'connected', timestamp: Date.now() });
  return { ok: true };
});

ipcMain.handle('monitor:disconnect', async () => {
  fullTeardown();
  send('ssh-status', { state: 'disconnected', timestamp: Date.now() });
  return { ok: true };
});

// Terminal: reuses the existing SSH connection (opened by monitor:connect)
// to request an interactive shell channel. One extra channel on the same
// connection — no second SSH login needed.
ipcMain.handle('terminal:start', async (_evt, { cols, rows }) => {
  if (!sshClient) {
    throw new Error('connect the SSH tunnel first');
  }
  closeTerminalStream();
  const size = {
    cols: Number.isInteger(cols) && cols > 0 ? cols : 80,
    rows: Number.isInteger(rows) && rows > 0 ? rows : 24,
  };
  return new Promise((resolve, reject) => {
    sshClient.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      terminalStream = stream;
      stream.on('data', (chunk) => send('terminal-data', chunk.toString('utf8')));
      stream.stderr.on('data', (chunk) => send('terminal-data', chunk.toString('utf8')));
      stream.on('error', () => {});
      stream.on('close', () => {
        send('terminal-data', '\r\n[session closed]\r\n');
        send('terminal-closed', { timestamp: Date.now() });
        if (terminalStream === stream) terminalStream = null;
      });
      resolve({ ok: true });
    });
  });
});

// Clipboard for the embedded terminal. The renderer is sandboxed, so the
// preload has no access to Electron's clipboard module — reads and writes
// are brokered here instead. Plain text only.
ipcMain.on('clipboard:write', (_evt, text) => {
  if (typeof text === 'string' && text.length > 0) clipboard.writeText(text);
});

ipcMain.handle('clipboard:read', () => clipboard.readText());

ipcMain.on('terminal:input', (_evt, data) => {
  if (terminalStream && typeof data === 'string') terminalStream.write(data);
});

ipcMain.on('terminal:resize', (_evt, { cols, rows }) => {
  if (!terminalStream) return;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
  terminalStream.setWindow(rows, cols, 0, 0);
});

// ---------------------------------------------------------------------
// Server tools: task manager + server specs.
//
// Both run plain shell commands over the SSH connection that
// monitor:connect already opened (one "exec" channel per request — no
// second login, no changes to the relay agent) and parse the output
// here in the main process. Linux-only (reads /proc and /sys), which is
// what the relay runs. Each window is a separate BrowserWindow that
// polls via invoke; when the SSH link is down the calls just return
// { ok: false } and the windows show "not connected" until it is back.

const EXEC_TIMEOUT_MS = 15000;
const EXEC_MAX_STDOUT = 4 * 1024 * 1024;
const EXEC_MAX_STDERR = 64 * 1024;

function sshExec(command) {
  return new Promise((resolve, reject) => {
    if (!sshClient) {
      reject(new Error('not connected'));
      return;
    }
    sshClient.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      let done = false;
      const finish = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => {
        try { stream.close(); } catch (_e) {}
        finish(reject, new Error('command timed out'));
      }, EXEC_TIMEOUT_MS);
      stream.on('data', (c) => {
        if (stdout.length < EXEC_MAX_STDOUT) stdout += c.toString('utf8');
      });
      stream.stderr.on('data', (c) => {
        if (stderr.length < EXEC_MAX_STDERR) stderr += c.toString('utf8');
      });
      stream.on('error', (e) => finish(reject, e));
      stream.on('close', (code) => finish(resolve, { stdout, stderr, code }));
    });
  });
}

// Output of the collection scripts is a sequence of "@@NAME" markers,
// each followed by that command's lines. Returns { NAME: [lines] }.
function splitSections(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('@@')) {
      cur = line.slice(2).trim();
      out[cur] = [];
      continue;
    }
    if (cur !== null) out[cur].push(line);
  }
  return out;
}

function firstLine(section) {
  return section && section.length ? section[0].trim() : '';
}

function parseMeminfo(lines) {
  const kb = {};
  for (const line of lines || []) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) kb[m[1]] = parseInt(m[2], 10) * 1024;
  }
  const total = kb.MemTotal ?? null;
  const available = kb.MemAvailable ?? null;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: total != null && available != null ? total - available : null,
    swapTotalBytes: kb.SwapTotal ?? null,
    swapUsedBytes: kb.SwapTotal != null && kb.SwapFree != null ? kb.SwapTotal - kb.SwapFree : null,
  };
}

// "cpu  user nice system idle iowait irq softirq steal ..." from /proc/stat
function parseCpuLine(line) {
  const parts = (line || '').trim().split(/\s+/);
  if (parts[0] !== 'cpu') return null;
  const n = parts.slice(1, 9).map((x) => parseInt(x, 10) || 0);
  const total = n.reduce((a, b) => a + b, 0);
  const idle = n[3] + n[4];
  return { total, idle };
}

function parseLoad(line) {
  const parts = (line || '').trim().split(/\s+/);
  const load = parts.slice(0, 3).map(parseFloat);
  return load.length === 3 && load.every(Number.isFinite) ? load : null;
}

// Two consecutive samples are needed for CPU percentages (ticks are
// cumulative), so the first reading of a session reports null and the
// next poll fills it in. Kept per-window-purpose so the task manager and
// specs windows don't disturb each other's deltas.
let cpuSamples = { processes: null, specs: null };
function resetCpuSamples() {
  cpuSamples = { processes: null, specs: null };
}

function systemCpuPercent(key, cpu) {
  const prev = cpuSamples[key];
  cpuSamples[key] = { ...(prev || {}), cpu };
  if (!prev || !prev.cpu || !cpu) return null;
  const dTotal = cpu.total - prev.cpu.total;
  const dIdle = cpu.idle - prev.cpu.idle;
  if (dTotal <= 0) return null;
  return round1(Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

const PROCESSES_SCRIPT = [
  'echo @@CPU; head -n1 /proc/stat',
  'echo @@NPROC; nproc 2>/dev/null',
  'echo @@PAGE; getconf PAGESIZE 2>/dev/null',
  "echo @@MEM; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  'echo @@LOAD; cat /proc/loadavg',
  'echo @@UPTIME; cat /proc/uptime',
  'echo @@STAT; cat /proc/[0-9]*/stat 2>/dev/null',
  // procps: pid, user (32 wide so long names aren't shown as uids), full args
  'echo @@PS; ps -eo pid=,user:32=,args= --cols 4000 2>/dev/null || ps -eo pid=,user=,args=',
].join('; ');

// /proc/<pid>/stat: "pid (comm) state ppid ... utime stime ... threads ... rss"
// comm may contain spaces and parentheses, so split around the LAST ')'.
function parseProcStat(line) {
  const open = line.indexOf('(');
  const close = line.lastIndexOf(')');
  if (open === -1 || close === -1) return null;
  const pid = parseInt(line.slice(0, open), 10);
  if (!Number.isInteger(pid)) return null;
  const f = line.slice(close + 2).split(' ');
  // f[i] is stat field (i + 3): state=3 ppid=4 utime=14 stime=15 num_threads=20 rss=24
  return {
    pid,
    name: line.slice(open + 1, close),
    state: f[0] || '?',
    ppid: parseInt(f[1], 10) || 0,
    ticks: (parseInt(f[11], 10) || 0) + (parseInt(f[12], 10) || 0),
    threads: parseInt(f[17], 10) || 0,
    rssPages: parseInt(f[21], 10) || 0,
  };
}

function parseProcesses(stdout) {
  const s = splitSections(stdout);
  if (!s.STAT || !s.PS || !s.CPU) throw new Error('unexpected output from the server (is it Linux?)');

  const cpu = parseCpuLine(firstLine(s.CPU));
  const ncpu = parseInt(firstLine(s.NPROC), 10) || 1;
  const pageSize = parseInt(firstLine(s.PAGE), 10) || 4096;
  const mem = parseMeminfo(s.MEM);
  const uptimeSeconds = parseFloat(firstLine(s.UPTIME)) || null;

  const psInfo = new Map(); // pid -> { user, args }
  for (const line of s.PS) {
    const m = line.match(/^\s*(\d+)\s+(\S+)\s*(.*)$/);
    if (m) psInfo.set(parseInt(m[1], 10), { user: m[2], args: m[3] });
  }

  const prev = cpuSamples.processes;
  const cpuPercent = systemCpuPercent('processes', cpu);
  const ticksNow = new Map();
  const dTotal = prev && prev.cpu && cpu ? cpu.total - prev.cpu.total : 0;

  const processes = [];
  for (const line of s.STAT) {
    if (!line.trim()) continue;
    const p = parseProcStat(line);
    if (!p) continue;
    ticksNow.set(p.pid, p.ticks);
    let procCpu = null;
    if (prev && prev.ticks && prev.ticks.has(p.pid) && dTotal > 0) {
      const d = p.ticks - prev.ticks.get(p.pid);
      // top-style: 100% == one full core
      procCpu = round1(Math.max(0, (d / dTotal) * ncpu * 100));
    }
    const info = psInfo.get(p.pid) || {};
    const rssBytes = p.rssPages * pageSize;
    processes.push({
      pid: p.pid,
      ppid: p.ppid,
      name: p.name,
      user: info.user || '?',
      args: info.args || p.name,
      state: p.state,
      threads: p.threads,
      rssBytes,
      cpuPercent: procCpu,
      memPercent: mem.totalBytes ? round1((rssBytes / mem.totalBytes) * 100) : null,
    });
  }
  cpuSamples.processes = { cpu, ticks: ticksNow };

  return {
    ok: true,
    timestamp: Date.now(),
    ncpu,
    cpuPercent,
    mem,
    load: parseLoad(firstLine(s.LOAD)),
    uptimeSeconds,
    processes,
  };
}

const SPECS_SCRIPT = [
  'echo @@HOST; hostname 2>/dev/null',
  'echo @@OS; cat /etc/os-release 2>/dev/null',
  'echo @@KERNEL; uname -srm 2>/dev/null',
  'echo @@UPTIME; cat /proc/uptime',
  'echo @@LOAD; cat /proc/loadavg',
  'echo @@NPROC; nproc 2>/dev/null',
  'echo @@LSCPU; lscpu 2>/dev/null',
  "echo @@CPUINFO; grep -m1 -E '^model name' /proc/cpuinfo 2>/dev/null",
  "echo @@CPUMHZ; grep -E '^cpu MHz' /proc/cpuinfo 2>/dev/null",
  'echo @@CPU; head -n1 /proc/stat',
  "echo @@MEM; grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
  'echo @@DISKS; lsblk -d -b -P -o NAME,SIZE,MODEL,ROTA,TYPE,TRAN 2>/dev/null || lsblk -d -b -P -o NAME,SIZE,MODEL,ROTA,TYPE 2>/dev/null',
  'echo @@DF; df -P -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null',
  'echo @@THERMAL; for z in /sys/class/thermal/thermal_zone*; do [ -r "$z/temp" ] && echo "$(cat "$z/type" 2>/dev/null)|$(cat "$z/temp" 2>/dev/null)"; done',
  'echo @@HWMON; for h in /sys/class/hwmon/hwmon*; do n=$(cat "$h/name" 2>/dev/null); for t in "$h"/temp*_input; do [ -r "$t" ] || continue; l=$(cat "${t%_input}_label" 2>/dev/null); echo "$n|$l|$(cat "$t" 2>/dev/null)"; done; done',
  'echo @@USERS; who 2>/dev/null | wc -l',
  "echo @@PROCS; ls /proc 2>/dev/null | grep -c '^[0-9]'",
  'echo @@IP; hostname -I 2>/dev/null',
  "echo @@GPU; lspci 2>/dev/null | grep -iE 'vga|3d|display'",
  'echo @@DMI; cat /sys/devices/virtual/dmi/id/sys_vendor /sys/devices/virtual/dmi/id/product_name 2>/dev/null',
  'true',
].join('; ');

function parseKeyValues(lines, sep) {
  const out = {};
  for (const line of lines || []) {
    const i = line.indexOf(sep);
    if (i === -1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// lsblk -P prints KEY="value" pairs, one device per line
function parsePairsLine(line) {
  const obj = {};
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(line)) !== null) obj[m[1]] = m[2].replace(/\\(.)/g, '$1');
  return obj;
}

function parseSpecs(stdout) {
  const s = splitSections(stdout);
  if (!s.MEM || !s.CPU || !s.UPTIME) throw new Error('unexpected output from the server (is it Linux?)');

  const osRelease = parseKeyValues(s.OS, '=');
  const lscpu = parseKeyValues(s.LSCPU, ':');
  const cpuinfo = parseKeyValues(s.CPUINFO, ':');
  const mhzValues = (s.CPUMHZ || [])
    .map((l) => parseFloat(l.split(':')[1]))
    .filter(Number.isFinite);
  const unquote = (v) => (v || '').replace(/^"|"$/g, '');

  const disks = (s.DISKS || [])
    .filter((l) => l.includes('NAME='))
    .map(parsePairsLine)
    .map((d) => ({
      name: d.NAME,
      sizeBytes: parseInt(d.SIZE, 10) || null,
      model: (d.MODEL || '').trim() || null,
      rotational: d.ROTA === '1',
      type: d.TYPE || null,
      transport: (d.TRAN || '').trim() || null,
    }));

  const filesystems = [];
  for (const line of (s.DF || []).slice(1)) {
    const m = line.match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/);
    if (!m) continue;
    filesystems.push({
      device: m[1],
      sizeBytes: parseInt(m[2], 10),
      usedBytes: parseInt(m[3], 10),
      availableBytes: parseInt(m[4], 10),
      usedPercent: parseInt(m[5], 10),
      mount: m[6].trim(),
    });
  }

  // hwmon has labelled sensors (coretemp "Core 0" etc); thermal zones
  // are the fallback for machines that expose nothing under hwmon.
  let temperatures = (s.HWMON || [])
    .map((l) => l.split('|'))
    .filter((p) => p.length === 3 && p[2].trim() !== '')
    .map((p) => ({ sensor: p[0], label: p[1] || null, celsius: round1(parseInt(p[2], 10) / 1000) }))
    .filter((t) => Number.isFinite(t.celsius));
  if (temperatures.length === 0) {
    temperatures = (s.THERMAL || [])
      .map((l) => l.split('|'))
      .filter((p) => p.length === 2 && p[1].trim() !== '')
      .map((p) => ({ sensor: p[0], label: null, celsius: round1(parseInt(p[1], 10) / 1000) }))
      .filter((t) => Number.isFinite(t.celsius));
  }

  const cores = parseInt(lscpu['Core(s) per socket'], 10) || null;
  const sockets = parseInt(lscpu['Socket(s)'], 10) || 1;
  const ipv4 = (firstLine(s.IP).split(/\s+/).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))) || null;
  const dmi = (s.DMI || []).map((l) => l.trim()).filter(Boolean);

  return {
    ok: true,
    timestamp: Date.now(),
    system: {
      hostname: firstLine(s.HOST) || null,
      os: unquote(osRelease.PRETTY_NAME) || null,
      kernel: firstLine(s.KERNEL) || null,
      machine: dmi.length ? dmi.join(' ') : null,
      uptimeSeconds: parseFloat(firstLine(s.UPTIME)) || null,
      load: parseLoad(firstLine(s.LOAD)),
      processes: parseInt(firstLine(s.PROCS), 10) || null,
      usersLoggedIn: parseInt(firstLine(s.USERS), 10) || 0,
      ipv4,
      gpu: (s.GPU || []).map((l) => l.replace(/^\S+\s+/, '').trim()).filter(Boolean),
    },
    cpu: {
      model: lscpu['Model name'] || cpuinfo['model name'] || null,
      architecture: lscpu.Architecture || null,
      threads: parseInt(lscpu['CPU(s)'], 10) || parseInt(firstLine(s.NPROC), 10) || null,
      cores: cores ? cores * sockets : null,
      sockets,
      maxMhz: parseFloat(lscpu['CPU max MHz']) || null,
      currentMhz: mhzValues.length ? round1(mhzValues.reduce((a, b) => a + b, 0) / mhzValues.length) : null,
      usagePercent: systemCpuPercent('specs', parseCpuLine(firstLine(s.CPU))),
    },
    memory: parseMeminfo(s.MEM),
    disks,
    filesystems,
    temperatures,
  };
}

function toolError(err) {
  const msg = err && err.message ? err.message : String(err);
  if (/not connected/i.test(msg)) return 'Not connected to the server.';
  return msg;
}

ipcMain.handle('sysinfo:processes', async () => {
  try {
    const { stdout } = await sshExec(PROCESSES_SCRIPT);
    return parseProcesses(stdout);
  } catch (err) {
    return { ok: false, error: toolError(err), timestamp: Date.now() };
  }
});

ipcMain.handle('sysinfo:specs', async () => {
  try {
    const { stdout } = await sshExec(SPECS_SCRIPT);
    return parseSpecs(stdout);
  } catch (err) {
    return { ok: false, error: toolError(err), timestamp: Date.now() };
  }
});

// End a process. Only TERM (polite) and KILL (forced) are allowed, and
// the pid is validated as a plain integer before it goes anywhere near a
// shell. Non-root SSH users can only signal their own processes; the
// EPERM from kill(2) is turned into a message that says so.
ipcMain.handle('sysinfo:kill', async (_evt, { pid, signal } = {}) => {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, error: 'Invalid process id.' };
  }
  if (pid === 1) {
    return { ok: false, error: 'Refusing to end PID 1 (init) — that would take the whole server down.' };
  }
  const sig = signal === 'KILL' ? 'KILL' : 'TERM';
  try {
    const { code, stderr } = await sshExec(`kill -s ${sig} ${pid}`);
    if (code === 0) return { ok: true, pid, signal: sig };
    const text = (stderr || '').trim();
    if (/not permitted/i.test(text)) {
      return {
        ok: false,
        error: `Permission denied: PID ${pid} belongs to another user. ` +
          'The SSH user can only end its own processes (use sudo in the terminal for others).',
      };
    }
    if (/no such process/i.test(text)) {
      return { ok: false, error: `PID ${pid} no longer exists.` };
    }
    return { ok: false, error: text || `kill exited with status ${code}` };
  } catch (err) {
    return { ok: false, error: toolError(err) };
  }
});

// --- tool windows ---
const toolWindows = {}; // name -> BrowserWindow

function openToolWindow(name, file, { width, height }) {
  const existing = toolWindows[name];
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return existing;
  }
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 520,
    minHeight: 360,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', file));
  win.on('closed', () => {
    if (toolWindows[name] === win) delete toolWindows[name];
  });
  toolWindows[name] = win;
  return win;
}

function closeToolWindows() {
  for (const name of Object.keys(toolWindows)) {
    const win = toolWindows[name];
    delete toolWindows[name];
    if (win && !win.isDestroyed()) win.close();
  }
}

ipcMain.handle('sysinfo:open-task-manager', () => {
  openToolWindow('taskManager', 'taskmanager.html', { width: 1000, height: 680 });
  return { ok: true };
});

ipcMain.handle('sysinfo:open-specs', () => {
  openToolWindow('specs', 'specs.html', { width: 820, height: 760 });
  return { ok: true };
});
