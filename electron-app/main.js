'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
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
          send('ssh-status', { state: 'error', error: err.message, timestamp: Date.now() });
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
        error: err.message,
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

ipcMain.handle('monitor:connect', async (_evt, cfg) => {
  fullTeardown();
  userDisconnected = false;
  await connectTunnel(cfg);
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

ipcMain.on('terminal:input', (_evt, data) => {
  if (terminalStream && typeof data === 'string') terminalStream.write(data);
});

ipcMain.on('terminal:resize', (_evt, { cols, rows }) => {
  if (!terminalStream) return;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return;
  terminalStream.setWindow(rows, cols, 0, 0);
});
