'use strict';
// Minimal electron stub so main.js can be exercised under plain node.
// Captures ipcMain handlers and webContents.send() traffic for the driver.

const handlers = {}; // invoke handlers
const listeners = {}; // ipcMain.on listeners
const sent = []; // every send(channel, payload)
const sendWatchers = [];

const fakeWebContents = {
  send(channel, payload) {
    const evt = { channel, payload, t: Date.now() };
    sent.push(evt);
    for (const w of sendWatchers.slice()) w(evt);
  },
};

class BrowserWindow {
  constructor() {
    BrowserWindow._instance = this;
    this.webContents = fakeWebContents;
  }
  loadFile() {}
  on() {}
  focus() {}
  restore() {}
  close() {}
  isMinimized() { return false; }
  isDestroyed() { return false; }
  static getAllWindows() { return BrowserWindow._instance ? [BrowserWindow._instance] : []; }
}

module.exports = {
  app: {
    whenReady: () => Promise.resolve(),
    on: () => {},
    getPath: () => process.env.FAKE_USERDATA || __dirname,
  },
  BrowserWindow,
  ipcMain: {
    handle: (channel, fn) => { handlers[channel] = fn; },
    on: (channel, fn) => { listeners[channel] = fn; },
  },
  // test hooks
  __invoke: (channel, ...args) => handlers[channel]({}, ...args),
  __emit: (channel, ...args) => listeners[channel]({}, ...args),
  __sent: sent,
  __onSend: (fn) => sendWatchers.push(fn),
  __offSend: (fn) => {
    const i = sendWatchers.indexOf(fn);
    if (i !== -1) sendWatchers.splice(i, 1);
  },
};
