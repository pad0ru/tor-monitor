'use strict';

const procBody = document.getElementById('procBody');
const filterInput = document.getElementById('filter');
const intervalSelect = document.getElementById('interval');
const endBtn = document.getElementById('endBtn');
const killBtn = document.getElementById('killBtn');
const statusEl = document.getElementById('status');
const shownEl = document.getElementById('shown');
const confirmBar = document.getElementById('confirmBar');
const confirmText = document.getElementById('confirmText');

let latest = null; // last successful snapshot from the server
let selectedPid = null;
let sortKey = 'cpuPercent';
let sortDesc = true;
let pendingKill = null; // { pid, name, signal }
let timer = null;
let inFlight = false;

const STATE_NAMES = {
  R: 'running', S: 'sleeping', D: 'disk wait', Z: 'zombie', T: 'stopped',
  t: 'traced', I: 'idle', X: 'dead',
};

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    const snap = await window.sysinfo.processes();
    if (!snap || !snap.ok) {
      statusEl.textContent = (snap && snap.error) || 'Failed to read processes.';
      statusEl.classList.add('warn');
      return;
    }
    statusEl.classList.remove('warn');
    latest = snap;
    renderSummary(snap);
    renderTable();
    statusEl.textContent = `Updated ${new Date(snap.timestamp).toLocaleTimeString()}` +
      (snap.cpuPercent == null ? ' (CPU % needs one more sample)' : '');
  } finally {
    inFlight = false;
  }
}

function renderSummary(snap) {
  setText('sumCpu', snap.cpuPercent == null ? '…' : formatPercent(snap.cpuPercent));
  setBar(document.getElementById('barCpu'), snap.cpuPercent);
  const m = snap.mem || {};
  const memPct = m.totalBytes ? (m.usedBytes / m.totalBytes) * 100 : null;
  setText('sumMem', m.totalBytes ? `${formatBytes(m.usedBytes)} / ${formatBytes(m.totalBytes)}` : '-');
  setBar(document.getElementById('barMem'), memPct);
  setText('sumLoad', snap.load ? snap.load.map((x) => x.toFixed(2)).join('  ') : '-');
  setText('sumCores', snap.ncpu ? `${snap.ncpu} logical CPU${snap.ncpu === 1 ? '' : 's'}` : '-');
  setText('sumProcs', snap.processes.length);
  setText('sumUptime', snap.uptimeSeconds != null ? `up ${formatDuration(snap.uptimeSeconds)}` : '-');
}

function compare(a, b) {
  const va = a[sortKey];
  const vb = b[sortKey];
  let r;
  if (typeof va === 'string' || typeof vb === 'string') {
    r = String(va ?? '').localeCompare(String(vb ?? ''), undefined, { sensitivity: 'base' });
  } else {
    // nulls (no CPU sample yet) sort last regardless of direction
    if (va == null && vb == null) r = 0;
    else if (va == null) return 1;
    else if (vb == null) return -1;
    else r = va - vb;
  }
  if (r === 0) r = (b.rssBytes || 0) - (a.rssBytes || 0);
  if (r === 0) r = a.pid - b.pid;
  return sortDesc ? -r : r;
}

function matchesFilter(p, q) {
  if (!q) return true;
  return (
    String(p.pid) === q ||
    p.name.toLowerCase().includes(q) ||
    p.user.toLowerCase().includes(q) ||
    p.args.toLowerCase().includes(q)
  );
}

function renderTable() {
  if (!latest) return;
  const q = filterInput.value.trim().toLowerCase();
  const rows = latest.processes.filter((p) => matchesFilter(p, q)).sort(compare);

  // Rebuild the body with DOM APIs (never innerHTML — process names and
  // command lines come straight from the server).
  const frag = document.createDocumentFragment();
  let selectedStillPresent = false;
  for (const p of rows) {
    const tr = document.createElement('tr');
    tr.dataset.pid = String(p.pid);
    if (p.pid === selectedPid) {
      tr.classList.add('selected');
      selectedStillPresent = true;
    }
    addCell(tr, p.pid, 'num');
    addCell(tr, p.name);
    addCell(tr, p.user);
    addCell(tr, p.cpuPercent == null ? '…' : p.cpuPercent.toFixed(1), 'num' + (p.cpuPercent >= 50 ? ' hot' : ''));
    addCell(tr, p.memPercent == null ? '-' : p.memPercent.toFixed(1), 'num');
    addCell(tr, formatBytes(p.rssBytes), 'num');
    addCell(tr, p.threads, 'num');
    const st = addCell(tr, STATE_NAMES[p.state] || p.state);
    if (p.state === 'Z') st.classList.add('warn');
    addCell(tr, p.args, 'cmd').title = p.args;
    frag.appendChild(tr);
  }
  procBody.replaceChildren(frag);
  if (selectedPid !== null && !selectedStillPresent && !q) {
    // process went away
    selectedPid = null;
    hideConfirm();
  }
  updateButtons();
  shownEl.textContent = q ? `${rows.length} of ${latest.processes.length} shown` : `${rows.length} processes`;
}

function addCell(tr, text, cls) {
  const td = document.createElement('td');
  td.textContent = text == null ? '-' : String(text);
  if (cls) td.className = cls;
  tr.appendChild(td);
  return td;
}

function updateButtons() {
  const has = selectedPid !== null;
  endBtn.disabled = !has;
  killBtn.disabled = !has;
}

function selectedProcess() {
  return latest ? latest.processes.find((p) => p.pid === selectedPid) : null;
}

function askKill(signal) {
  const p = selectedProcess();
  if (!p) return;
  pendingKill = { pid: p.pid, name: p.name, signal };
  confirmText.textContent = signal === 'KILL'
    ? `Force kill PID ${p.pid} (${p.name})? It gets no chance to save anything.`
    : `End PID ${p.pid} (${p.name})?`;
  confirmBar.classList.remove('hidden');
  document.getElementById('confirmYes').focus();
}

function hideConfirm() {
  pendingKill = null;
  confirmBar.classList.add('hidden');
}

async function doKill() {
  if (!pendingKill) return;
  const { pid, name, signal } = pendingKill;
  hideConfirm();
  const res = await window.sysinfo.kill(pid, signal);
  if (res && res.ok) {
    statusEl.classList.remove('warn');
    statusEl.textContent = `${signal === 'KILL' ? 'Killed' : 'Asked to end'} PID ${pid} (${name}).`;
    setTimeout(refresh, 400);
  } else {
    statusEl.classList.add('warn');
    statusEl.textContent = (res && res.error) || `Could not signal PID ${pid}.`;
  }
}

// --- wiring ---
procBody.addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const pid = parseInt(tr.dataset.pid, 10);
  selectedPid = selectedPid === pid ? null : pid;
  hideConfirm();
  renderTable();
});

document.querySelectorAll('#procTable th').forEach((th) => {
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDesc = !sortDesc;
    } else {
      sortKey = key;
      sortDesc = key === 'cpuPercent' || key === 'memPercent' || key === 'rssBytes' || key === 'threads';
    }
    document.querySelectorAll('#procTable th').forEach((h) => h.classList.remove('sorted', 'desc'));
    th.classList.add('sorted');
    if (sortDesc) th.classList.add('desc');
    renderTable();
  });
});

filterInput.addEventListener('input', renderTable);
endBtn.addEventListener('click', () => askKill('TERM'));
killBtn.addEventListener('click', () => askKill('KILL'));
document.getElementById('confirmYes').addEventListener('click', doKill);
document.getElementById('confirmNo').addEventListener('click', hideConfirm);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideConfirm();
  if (e.key === 'Delete' && selectedPid !== null && document.activeElement !== filterInput) {
    askKill(e.shiftKey ? 'KILL' : 'TERM');
  }
});

function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  const ms = parseInt(intervalSelect.value, 10);
  if (ms > 0) timer = setInterval(refresh, ms);
}
intervalSelect.addEventListener('change', () => {
  schedule();
  if (parseInt(intervalSelect.value, 10) > 0) refresh();
});

refresh();
// CPU % needs two samples: take the second one quickly instead of
// waiting a full interval.
setTimeout(refresh, 700);
schedule();
