'use strict';
// Small formatting helpers shared by the tool windows (task manager,
// server specs). Loaded via a plain <script> tag before the page script.

function formatBytes(bytes, digits) {
  if (bytes == null || !Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const d = digits != null ? digits : (i === 0 ? 0 : v < 10 ? 2 : 1);
  return `${v.toFixed(d)} ${units[i]}`;
}

function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '-';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s % 60}s`;
}

function formatPercent(n) {
  return n == null || !Number.isFinite(n) ? '-' : `${n.toFixed(1)}%`;
}

// Fill a .bar element's inner .bar-fill to `percent`, colouring it by
// how full it is (green / amber / red).
function setBar(el, percent) {
  const fill = el.querySelector('.bar-fill');
  const p = percent == null || !Number.isFinite(percent) ? 0 : Math.max(0, Math.min(100, percent));
  fill.style.width = `${p}%`;
  fill.classList.remove('warn', 'crit');
  if (p >= 90) fill.classList.add('crit');
  else if (p >= 70) fill.classList.add('warn');
}

function setText(id, text) {
  document.getElementById(id).textContent = text == null || text === '' ? '-' : String(text);
}
