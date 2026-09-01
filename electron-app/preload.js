'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The embedded xterm.js terminal has no native copy/paste — every keystroke
// is forwarded to the remote shell. The renderer is sandboxed, so the
// clipboard module isn't available here; reads/writes go through IPC to the
// main process. Plain text only. Note readText is async (invoke).
contextBridge.exposeInMainWorld('clipboard', {
  writeText: (text) => ipcRenderer.send('clipboard:write', String(text)),
  readText: () => ipcRenderer.invoke('clipboard:read'),
});

contextBridge.exposeInMainWorld('monitor', {
  connect: (cfg) => ipcRenderer.invoke('monitor:connect', cfg),
  disconnect: () => ipcRenderer.invoke('monitor:disconnect'),
  onAgentStats: (cb) => ipcRenderer.on('agent-stats', (_evt, data) => cb(data)),
  onOnionooStats: (cb) => ipcRenderer.on('onionoo-stats', (_evt, data) => cb(data)),
  onSshStatus: (cb) => ipcRenderer.on('ssh-status', (_evt, data) => cb(data)),
});

contextBridge.exposeInMainWorld('terminal', {
  start: (size) => ipcRenderer.invoke('terminal:start', size),
  sendInput: (data) => ipcRenderer.send('terminal:input', data),
  resize: (size) => ipcRenderer.send('terminal:resize', size),
  onData: (cb) => ipcRenderer.on('terminal-data', (_evt, data) => cb(data)),
  onClosed: (cb) => ipcRenderer.on('terminal-closed', (_evt, data) => cb(data)),
});
