'use strict';
// Shared test setup: throwaway SSH host keys, cookie file, and child
// processes for the mock control port + relay agent.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TEST_DIR = __dirname;
const REPO = path.join(__dirname, '..');

function ensureHostKey(name) {
  const file = path.join(TEST_DIR, name);
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    fs.writeFileSync(file, privateKey);
  }
  return fs.readFileSync(file);
}

function ensureCookie() {
  const file = path.join(TEST_DIR, 'test.cookie');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32));
  return file;
}

// Runs a script with node even when the current binary is Electron.
function spawnNode(script, env) {
  const child = spawn(process.execPath, [script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env },
    stdio: 'ignore',
  });
  child.on('error', (err) => console.error(`failed to spawn ${script}:`, err.message));
  return child;
}

// Starts mock control port + the real relay agent; resolves once the
// agent's /stats endpoint responds.
async function startAgentStack({ controlPort, agentPort }) {
  const cookie = ensureCookie();
  const mock = spawnNode(path.join(TEST_DIR, 'mock-control.js'), {
    MOCK_PORT: String(controlPort),
    MOCK_COOKIE: cookie,
  });
  await new Promise((r) => setTimeout(r, 400));
  const agent = spawnNode(path.join(REPO, 'relay-agent', 'server.js'), {
    CONTROL_PORT: String(controlPort),
    COOKIE_PATH: cookie,
    HTTP_PORT: String(agentPort),
    POLL_INTERVAL_MS: '500',
  });
  const http = require('http');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const ok = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: agentPort, path: '/stats', timeout: 1000 },
        (res) => { res.resume(); resolve(true); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) return { mock, agent, stop: () => { mock.kill(); agent.kill(); } };
  }
  mock.kill();
  agent.kill();
  throw new Error('relay agent did not come up');
}

module.exports = { TEST_DIR, REPO, ensureHostKey, ensureCookie, startAgentStack };
