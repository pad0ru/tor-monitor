'use strict';

const REFRESH_MS = 5000;
const statusEl = document.getElementById('status');
let inFlight = false;

// Pick the sensor to headline as "the" CPU temperature: package /
// die sensors first, then anything CPU-ish, else the hottest reading.
function cpuTemperature(temps) {
  if (!temps || temps.length === 0) return null;
  const score = (t) => {
    const s = `${t.sensor} ${t.label || ''}`.toLowerCase();
    if (/package|pkg|tdie|tctl/.test(s)) return 3;
    if (/coretemp|k10temp|cpu|soc/.test(s)) return 2;
    return 0;
  };
  const best = temps.slice().sort((a, b) => score(b) - score(a) || b.celsius - a.celsius)[0];
  return best.celsius;
}

function renderMotd(d) {
  const root = d.filesystems.find((f) => f.mount === '/') || d.filesystems[0];
  const mem = d.memory;
  const memPct = mem.totalBytes ? (mem.usedBytes / mem.totalBytes) * 100 : null;
  const swapPct = mem.swapTotalBytes ? (mem.swapUsedBytes / mem.swapTotalBytes) * 100 : null;
  const temp = cpuTemperature(d.temperatures);
  const lines = [
    ['System load', d.system.load ? d.system.load[0].toFixed(2) : '-'],
    ['Usage of ' + (root ? root.mount : '/'), root ? `${root.usedPercent}% of ${formatBytes(root.sizeBytes)}` : '-'],
    ['Memory usage', memPct == null ? '-' : `${memPct.toFixed(0)}%`],
    ['Swap usage', swapPct == null ? (mem.swapTotalBytes === 0 ? 'no swap' : '-') : `${swapPct.toFixed(0)}%`],
    ['Temperature', temp == null ? 'n/a' : `${temp.toFixed(1)} °C`],
    ['Processes', d.system.processes ?? '-'],
    ['Users logged in', d.system.usersLoggedIn ?? '-'],
    ['IPv4 address', d.system.ipv4 || '-'],
  ];
  const width = Math.max(...lines.map((l) => l[0].length)) + 2;
  document.getElementById('motd').textContent = lines
    .map(([k, v]) => `  ${(k + ':').padEnd(width)} ${v}`)
    .join('\n');
}

function renderList(el, items, renderItem) {
  const frag = document.createDocumentFragment();
  for (const it of items) frag.appendChild(renderItem(it));
  el.replaceChildren(frag);
  if (items.length === 0) el.textContent = '-';
}

function rowWithBar(label, detail, percent) {
  const row = document.createElement('div');
  row.className = 'row';
  const head = document.createElement('div');
  head.className = 'row-head';
  const l = document.createElement('span');
  l.textContent = label;
  const dtl = document.createElement('span');
  dtl.className = 'sub';
  dtl.textContent = detail;
  head.append(l, dtl);
  row.appendChild(head);
  if (percent != null) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.appendChild(Object.assign(document.createElement('div'), { className: 'bar-fill' }));
    setBar(bar, percent);
    row.appendChild(bar);
  }
  return row;
}

function render(d) {
  const sys = d.system;
  setText('specHost', sys.hostname || 'Server specs');
  setText('specOsLine', [sys.os, sys.kernel].filter(Boolean).join(' · '));
  renderMotd(d);

  setText('sysHostname', sys.hostname);
  setText('sysMachine', sys.machine);
  setText('sysOs', sys.os);
  setText('sysKernel', sys.kernel);
  setText('sysUptime', formatDuration(sys.uptimeSeconds));
  setText('sysIp', sys.ipv4);
  setText('sysGpu', sys.gpu && sys.gpu.length ? sys.gpu.join('; ') : 'none detected');

  const c = d.cpu;
  setText('cpuModel', c.model);
  setText('cpuCores', c.cores && c.threads ? `${c.cores} cores / ${c.threads} threads` : c.threads ? `${c.threads} threads` : null);
  setText('cpuArch', c.architecture);
  setText('cpuClock', c.currentMhz || c.maxMhz
    ? `${c.currentMhz ? c.currentMhz.toFixed(0) + ' MHz now' : ''}${c.currentMhz && c.maxMhz ? ', ' : ''}${c.maxMhz ? c.maxMhz.toFixed(0) + ' MHz max' : ''}`
    : null);
  setText('cpuLoad', sys.load ? sys.load.map((x) => x.toFixed(2)).join('  ') : null);
  setText('cpuUsage', c.usagePercent == null ? '… (sampling)' : formatPercent(c.usagePercent));
  setBar(document.getElementById('barCpu'), c.usagePercent);

  const m = d.memory;
  const memPct = m.totalBytes ? (m.usedBytes / m.totalBytes) * 100 : null;
  setText('memRam', m.totalBytes ? `${formatBytes(m.usedBytes)} used of ${formatBytes(m.totalBytes)} (${memPct.toFixed(0)}%)` : null);
  setText('memAvail', formatBytes(m.availableBytes));
  setBar(document.getElementById('barMem'), memPct);
  const swapPct = m.swapTotalBytes ? (m.swapUsedBytes / m.swapTotalBytes) * 100 : null;
  setText('memSwap', m.swapTotalBytes ? `${formatBytes(m.swapUsedBytes)} used of ${formatBytes(m.swapTotalBytes)} (${swapPct.toFixed(0)}%)` : 'none');
  setBar(document.getElementById('barSwap'), swapPct);

  renderList(document.getElementById('temps'), d.temperatures, (t) => {
    const name = t.label ? `${t.sensor} · ${t.label}` : t.sensor;
    // 0–100 °C mapped onto the bar; colour thresholds match the bar's
    // generic 70/90 warn/crit levels which happen to suit CPU temps.
    return rowWithBar(name, `${t.celsius.toFixed(1)} °C`, t.celsius);
  });

  renderList(document.getElementById('disks'), d.disks, (disk) => {
    const kind = disk.type === 'disk' ? (disk.rotational ? 'HDD' : 'SSD') : disk.type || '';
    const parts = [disk.model, kind, disk.transport && disk.transport.toUpperCase()].filter(Boolean);
    return rowWithBar(`/dev/${disk.name}`, `${formatBytes(disk.sizeBytes)}${parts.length ? ' · ' + parts.join(' · ') : ''}`, null);
  });

  renderList(document.getElementById('filesystems'), d.filesystems, (fs) =>
    rowWithBar(fs.mount, `${formatBytes(fs.usedBytes)} of ${formatBytes(fs.sizeBytes)} used (${fs.usedPercent}%) · ${fs.device}`, fs.usedPercent));
}

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  try {
    const d = await window.sysinfo.specs();
    if (!d || !d.ok) {
      statusEl.textContent = (d && d.error) || 'Failed to read server specs.';
      statusEl.classList.add('warn');
      return;
    }
    statusEl.classList.remove('warn');
    render(d);
    statusEl.textContent = `Updated ${new Date(d.timestamp).toLocaleTimeString()} · refreshes every ${REFRESH_MS / 1000}s`;
  } finally {
    inFlight = false;
  }
}

refresh();
setTimeout(refresh, 1000); // second sample so CPU usage has a delta
setInterval(refresh, REFRESH_MS);
