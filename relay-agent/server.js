'use strict';

/**
 * Tor relay monitoring agent.
 *
 * Connects to Tor's local ControlPort, authenticates using the cookie
 * file, and periodically polls a small set of GETINFO values. Exposes
 * the latest reading as JSON on a localhost-only HTTP server, meant to
 * be reached through an SSH tunnel (never expose this port publicly).
 *
 * Config via environment variables (all optional):
 *   CONTROL_HOST      default 127.0.0.1
 *   CONTROL_PORT      default 9051
 *   COOKIE_PATH       default /run/tor/control.authcookie
 *   HTTP_HOST         default 127.0.0.1
 *   HTTP_PORT         default 5001
 *   POLL_INTERVAL_MS  default 2000
 *   AGENT_TOKEN       optional shared secret; if set, requests must send
 *                     header  x-agent-token: <value>
 */

const net = require('net');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const CONTROL_HOST = process.env.CONTROL_HOST || '127.0.0.1';
const CONTROL_PORT = parseInt(process.env.CONTROL_PORT || '9051', 10);
const COOKIE_PATH = process.env.COOKIE_PATH || '/run/tor/control.authcookie';
const HTTP_HOST = process.env.HTTP_HOST || '127.0.0.1';
const HTTP_PORT = parseInt(process.env.HTTP_PORT || '5001', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '2000', 10);
const AGENT_TOKEN = process.env.AGENT_TOKEN || null;

let socket = null;
let pending = null; // { resolve, reject, replies: [], dataKey, dataLines }
let recvBuffer = '';

let latest = {
  ok: false,
  error: 'not connected yet',
  timestamp: null,
  uptimeSeconds: null,
  version: null,
  readBytes: null,
  writtenBytes: null,
  readRateKBs: null,
  writeRateKBs: null,
};

let lastSample = null; // { t, readBytes, writtenBytes } for rate calc

function connectControl() {
  const sock = net.connect(CONTROL_PORT, CONTROL_HOST, () => {
    authenticate().catch((err) => {
      latest = { ok: false, error: 'auth failed: ' + err.message, timestamp: Date.now() };
    });
  });
  socket = sock;

  sock.on('data', (chunk) => {
    recvBuffer += chunk.toString('utf8');
    drainBuffer();
  });

  sock.on('error', (err) => {
    latest = { ok: false, error: 'control connection error: ' + err.message, timestamp: Date.now() };
  });

  sock.on('close', () => {
    if (socket === sock) socket = null;
    failPending(new Error('control connection closed'));
    recvBuffer = '';
    stopPolling();
    if (latest.ok) {
      latest = { ok: false, error: 'control connection closed, reconnecting', timestamp: Date.now() };
    }
    scheduleReconnect();
  });
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectControl();
  }, 5000);
}

function failPending(err) {
  if (!pending) return;
  const p = pending;
  pending = null;
  p.reject(err);
}

/**
 * Splits the incoming stream into control-protocol replies.
 *
 * Reply lines come in three shapes (per control-spec):
 *   250-key=value   mid-reply line
 *   250+key=        start of a data block: body lines follow, terminated
 *                   by a line containing only "."; body lines starting
 *                   with "." are escaped by doubling the dot. Body lines
 *                   may look like status lines ("250 whatever"), so the
 *                   terminator check must be suspended inside a block.
 *   250 OK          final line — ends the reply
 * Unsolicited async events (650 ...) are ignored — we never SETEVENTS,
 * but being tolerant here is cheap.
 */
function drainBuffer() {
  let idx;
  while ((idx = recvBuffer.indexOf('\r\n')) !== -1) {
    const line = recvBuffer.slice(0, idx);
    recvBuffer = recvBuffer.slice(idx + 2);
    handleLine(line);
  }
}

function handleLine(line) {
  if (!pending) return; // greeting, async events, stray lines

  // Inside a data block: everything is payload until the lone "." line.
  if (pending.dataKey !== null) {
    if (line === '.') {
      pending.replies.push({ key: pending.dataKey, value: pending.dataLines.join('\n') });
      pending.dataKey = null;
      pending.dataLines = [];
    } else {
      pending.dataLines.push(line.startsWith('..') ? line.slice(1) : line);
    }
    return;
  }

  const m = line.match(/^(\d{3})([ +-])(.*)$/);
  if (!m) return; // malformed line; skip rather than wedge

  const code = m[1];
  const sep = m[2];
  const rest = m[3];

  if (code.startsWith('6')) return; // async event, not ours

  if (sep === '+') {
    // "250+key=" opens a data block (any inline text after = belongs to it)
    const eq = rest.indexOf('=');
    pending.dataKey = eq !== -1 ? rest.slice(0, eq) : rest;
    pending.dataLines = [];
    return;
  }

  if (sep === '-') {
    const eq = rest.indexOf('=');
    if (eq !== -1) {
      pending.replies.push({ key: rest.slice(0, eq), value: rest.slice(eq + 1) });
    }
    return;
  }

  // sep === ' ' — final line of the reply
  const p = pending;
  pending = null;
  if (code[0] === '2') {
    p.resolve(p.replies);
  } else {
    p.reject(new Error(code + ' ' + rest));
  }
}

function sendCommand(cmd) {
  return new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('a command is already in flight'));
      return;
    }
    if (!socket || socket.destroyed || !socket.writable) {
      reject(new Error('control connection is down'));
      return;
    }
    pending = { resolve, reject, replies: [], dataKey: null, dataLines: [] };
    socket.write(cmd + '\r\n', (err) => {
      if (err) failPending(err);
    });
  });
}

async function authenticate() {
  const cookie = fs.readFileSync(COOKIE_PATH);
  const hex = cookie.toString('hex');
  await sendCommand('AUTHENTICATE ' + hex);
  startPolling();
}

function repliesToMap(replies) {
  const values = {};
  for (const r of replies) values[r.key] = r.value;
  return values;
}

function toInt(s) {
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

async function poll() {
  try {
    const replies = await sendCommand('GETINFO traffic/read traffic/written uptime version');
    const v = repliesToMap(replies);
    const readBytes = toInt(v['traffic/read']);
    const writtenBytes = toInt(v['traffic/written']);
    const uptimeSeconds = toInt(v['uptime']);
    const version = v['version'] || null;
    const now = Date.now();

    let readRateKBs = null;
    let writeRateKBs = null;
    if (lastSample && readBytes !== null && writtenBytes !== null) {
      const dt = (now - lastSample.t) / 1000;
      if (dt > 0) {
        readRateKBs = (readBytes - lastSample.readBytes) / 1024 / dt;
        writeRateKBs = (writtenBytes - lastSample.writtenBytes) / 1024 / dt;
      }
    }
    if (readBytes !== null && writtenBytes !== null) {
      lastSample = { t: now, readBytes, writtenBytes };
    }

    latest = {
      ok: true,
      error: null,
      timestamp: now,
      uptimeSeconds,
      version,
      readBytes,
      writtenBytes,
      // Math.max(0, ...) so a Tor restart (counters reset) shows 0, not
      // a huge negative spike
      readRateKBs: readRateKBs !== null ? Math.max(0, round2(readRateKBs)) : null,
      writeRateKBs: writeRateKBs !== null ? Math.max(0, round2(writeRateKBs)) : null,
    };
  } catch (err) {
    latest = { ok: false, error: 'poll failed: ' + err.message, timestamp: Date.now() };
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

let pollTimer = null;
function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function tokenMatches(sent) {
  if (typeof sent !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(AGENT_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const server = http.createServer((req, res) => {
  if (AGENT_TOKEN) {
    if (!tokenMatches(req.headers['x-agent-token'])) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }
  }
  if (req.url === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(latest));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
});

server.listen(HTTP_PORT, HTTP_HOST, () => {
  console.log(`Agent HTTP listening on ${HTTP_HOST}:${HTTP_PORT} (localhost only)`);
});

connectControl();
