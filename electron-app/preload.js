'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
