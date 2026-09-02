'use strict';

const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const connError = document.getElementById('connError');
const statusPanel = document.getElementById('status-panel');
const chartSection = document.getElementById('chart-section');

const MAX_POINTS = 60;
const labels = [];
const readData = [];
const writeData = [];

const ctx = document.getElementById('bwChart');
const chart = new Chart(ctx, {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'Read KB/s',
        data: readData,
        borderColor: '#378ADD',
        backgroundColor: 'rgba(55,138,221,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25,
        fill: true,
      },
      {
        label: 'Write KB/s',
        data: writeData,
        borderColor: '#EF9F27',
        backgroundColor: 'rgba(239,159,39,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.25,
        fill: true,
      },
    ],
  },
  options: {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    scales: {
      y: { beginAtZero: true, ticks: { color: '#9a9a9a' }, grid: { color: '#2a2a30' } },
      x: { ticks: { display: false }, grid: { display: false } },
    },
    plugins: {
      legend: {
        display: true,
        position: 'top',
        align: 'end',
        labels: { color: '#eaeaea', boxWidth: 12, boxHeight: 12, usePointStyle: true },
      },
    },
  },
});

function pushBandwidthPoint(stats) {
  const t = new Date(stats.timestamp || Date.now()).toLocaleTimeString();
  labels.push(t);
  readData.push(stats.readRateKBs ?? 0);
  writeData.push(stats.writeRateKBs ?? 0);
  if (labels.length > MAX_POINTS) {
    labels.shift();
    readData.shift();
    writeData.shift();
  }
  chart.update();
}

function formatUptime(seconds) {
  if (seconds == null) return '-';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

window.monitor.onAgentStats((stats) => {
  if (!stats.ok) {
    document.getElementById('statUptime').textContent = stats.error || 'agent unreachable';
    document.getElementById('statVersion').textContent = '-';
    document.getElementById('statReadRate').textContent = '-';
    document.getElementById('statWriteRate').textContent = '-';
    return;
  }
  document.getElementById('statUptime').textContent = formatUptime(stats.uptimeSeconds);
  document.getElementById('statVersion').textContent = stats.version || '-';
  document.getElementById('statReadRate').textContent =
    stats.readRateKBs != null ? `${stats.readRateKBs} KB/s` : '-';
  document.getElementById('statWriteRate').textContent =
    stats.writeRateKBs != null ? `${stats.writeRateKBs} KB/s` : '-';
  pushBandwidthPoint(stats);
});

window.monitor.onOnionooStats((data) => {
  if (!data.ok || !data.relay) {
    document.getElementById('statFlags').textContent = '-';
    document.getElementById('statWeight').textContent = '-';
    return;
  }
  const relay = data.relay;
  document.getElementById('statFlags').textContent = (relay.flags || []).join(', ') || '-';
  document.getElementById('statWeight').textContent =
    relay.consensus_weight != null ? String(relay.consensus_weight) : '-';
});

const sshStatus = document.getElementById('sshStatus');

window.monitor.onSshStatus((s) => {
  sshStatus.classList.remove('ok', 'warn');
  if (s.state === 'connected') {
    sshStatus.classList.add('ok');
    sshStatus.textContent = s.reconnected ? 'reconnected' : 'connected';
    connectBtn.disabled = true;
    disconnectBtn.disabled = false;
    if (s.reconnected && term) {
      term.write('\r\n[SSH reconnected — press "Open terminal" for a new shell]\r\n');
    }
  } else if (s.state === 'reconnecting') {
    sshStatus.classList.add('warn');
    sshStatus.textContent = 'connection lost — reconnecting…' + (s.error ? ` (${s.error})` : '');
    disconnectBtn.disabled = false; // allow the user to give up
  } else if (s.state === 'disconnected') {
    sshStatus.textContent = 'disconnected';
    connectBtn.disabled = false;
    disconnectBtn.disabled = true;
  } else if (s.state === 'error') {
    sshStatus.classList.add('warn');
    sshStatus.textContent = 'SSH error: ' + (s.error || 'unknown');
  }
});

connectBtn.addEventListener('click', async () => {
  connError.textContent = '';
  const cfg = {
    sshHost: val('sshHost'),
    sshPort: parseInt(val('sshPort') || '22', 10),
    sshUsername: val('sshUsername'),
    password: val('sshPassword') || undefined,
    privateKeyPath: val('privateKeyPath') || undefined,
    passphrase: val('passphrase') || undefined,
    agentHost: '127.0.0.1',
    agentPort: parseInt(val('agentPort') || '5001', 10),
    localPort: parseInt(val('localPort') || '15001', 10),
    agentToken: val('agentToken') || undefined,
    fingerprint: val('fingerprint') || undefined,
  };

  connectBtn.disabled = true;
  try {
    const result = await window.monitor.connect(cfg);
    if (!result || !result.ok) {
      connError.textContent = (result && result.error) || 'Connection failed.';
      connectBtn.disabled = false;
      return;
    }
    disconnectBtn.disabled = false;
    statusPanel.classList.remove('hidden');
    chartSection.classList.remove('hidden');
    document.getElementById('terminal-section').classList.remove('hidden');
    document.getElementById('tools-section').classList.remove('hidden');
  } catch (err) {
    // Shouldn't normally happen (monitor:connect no longer throws), but
    // guard in case of an unexpected IPC-level failure.
    connError.textContent = 'Connection failed: ' + (err && err.message ? err.message : err);
    connectBtn.disabled = false;
  }
});

disconnectBtn.addEventListener('click', async () => {
  try {
    await window.monitor.disconnect();
  } catch (_err) {
    // teardown is best-effort; the UI reset below still applies
  }
  connectBtn.disabled = false;
  disconnectBtn.disabled = true;
});

function val(id) {
  return document.getElementById(id).value.trim();
}

// --- Server tools (separate windows) ---
document.getElementById('openTaskManagerBtn').addEventListener('click', () => {
  window.sysinfo.openTaskManager();
});
document.getElementById('openSpecsBtn').addEventListener('click', () => {
  window.sysinfo.openSpecs();
});

// --- Terminal ---
let term = null;
let fitAddon = null;
let terminalStarted = false;

document.getElementById('openTerminalBtn').addEventListener('click', async () => {
  if (!term) {
    term = new Terminal({
      fontSize: 13,
      theme: { background: '#111114', foreground: '#eaeaea' },
      cursorBlink: true,
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById('terminalHost'));
    fitAddon.fit();

    // Copy/paste. xterm forwards keystrokes to the shell, so Ctrl+C is
    // SIGINT and Ctrl+V is literal. Ctrl+Shift+C is also Chromium's
    // built-in "Inspect Element" devtools shortcut, which intercepts the
    // keystroke before page JS ever sees it — so copy uses the other
    // classic terminal-emulator convention, Ctrl+Insert, to avoid the
    // collision. Ctrl+Shift+V (paste) has no such conflict.
    const pasteFromClipboard = async () => {
      const text = await window.clipboard.readText();
      if (text) window.terminal.sendInput(text);
    };
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;
      if (e.ctrlKey && !e.shiftKey && e.key === 'Insert') {
        const sel = term.getSelection();
        if (sel) window.clipboard.writeText(sel);
        e.preventDefault();
        return false; // handled; don't forward to the shell
      }
      if ((e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) || (!e.ctrlKey && e.shiftKey && e.key === 'Insert')) {
        // preventDefault so Chromium's own paste-into-textarea doesn't
        // fire too (xterm forwards that as well — text would paste twice).
        e.preventDefault();
        pasteFromClipboard();
        return false;
      }
      return true;
    });
    document.getElementById('terminalHost').addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sel = term.getSelection();
      if (sel) {
        // Text is selected: right-click copies it (and clears the selection).
        window.clipboard.writeText(sel);
        term.clearSelection();
      } else {
        // Nothing selected: right-click pastes.
        pasteFromClipboard();
      }
    });

    term.onData((data) => window.terminal.sendInput(data));
    window.terminal.onData((data) => term.write(data));
    window.terminal.onClosed(() => {
      terminalStarted = false;
      term.write('[press "Open terminal" to start a new shell]\r\n');
    });

    window.addEventListener('resize', () => {
      if (!terminalStarted) return;
      fitAddon.fit();
      window.terminal.resize({ cols: term.cols, rows: term.rows });
    });
  }

  try {
    // Fit before starting so the PTY is allocated at the size the
    // terminal is actually rendered at (the section may have just
    // become visible).
    fitAddon.fit();
    // Each start is a brand-new shell session (possibly as a different
    // user after a reconnect), so wipe the previous session's screen,
    // scrollback, and any leftover terminal modes (e.g. an alternate
    // screen from vim/htop that was open when the old session died).
    term.reset();
    await window.terminal.start({ cols: term.cols, rows: term.rows });
    terminalStarted = true;
    window.terminal.resize({ cols: term.cols, rows: term.rows });
    term.focus();
  } catch (err) {
    term.write(`\r\n[failed to start terminal: ${err && err.message ? err.message : err}]\r\n`);
  }
});
