'use strict';
// Mock Tor ControlPort server for testing relay-agent/server.js.
// Speaks just enough of the control protocol: AUTHENTICATE + GETINFO.
// Env:
//   MOCK_PORT (default 19051)
//   MOCK_COOKIE (path to cookie file it will accept)
//   MOCK_MULTILINE=1  -> also include a 250+ data reply before the normal
//                        keys, with a body line that starts "250 " to try
//                        to trick naive terminator detection
//   MOCK_DROP_AFTER=N -> destroy the connection after N GETINFO replies
const net = require('net');
const fs = require('fs');

const PORT = parseInt(process.env.MOCK_PORT || '19051', 10);
const COOKIE = fs.readFileSync(process.env.MOCK_COOKIE).toString('hex');
const MULTILINE = process.env.MOCK_MULTILINE === '1';
const DROP_AFTER = parseInt(process.env.MOCK_DROP_AFTER || '0', 10);

let read = 1024 * 1024;
let written = 512 * 1024;
let uptime = 7920;

const server = net.createServer((sock) => {
  console.log('[mock] client connected');
  let buf = '';
  let getinfoCount = 0;
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handle(line);
    }
  });
  sock.on('error', () => {});

  function handle(line) {
    console.log('[mock] <<', line);
    if (line.startsWith('AUTHENTICATE')) {
      const arg = line.split(' ')[1] || '';
      if (arg.toLowerCase() === COOKIE) sock.write('250 OK\r\n');
      else {
        sock.write('515 Authentication failed: Wrong cookie\r\n');
        sock.end();
      }
      return;
    }
    if (line.startsWith('GETINFO')) {
      getinfoCount++;
      // advance fake counters like a live relay
      read += 40960 + Math.floor(Math.random() * 8192);
      written += 20480 + Math.floor(Math.random() * 8192);
      uptime += 2;
      let reply = '';
      if (MULTILINE) {
        // Real Tor formats some GETINFO answers as data replies:
        // 250+key=CRLF <lines> CRLF . CRLF ... then the closing 250 OK.
        // Include a body line starting with "250 " to catch parsers that
        // treat any ^\d{3}<space> line as the end of the reply.
        reply += '250+orconn-status=\r\n';
        reply += '$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA~relayA CONNECTED\r\n';
        reply += '250 tricky body line that is NOT a terminator\r\n';
        reply += '$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB~relayB CONNECTED\r\n';
        reply += '.\r\n';
      }
      reply += `250-traffic/read=${read}\r\n`;
      reply += `250-traffic/written=${written}\r\n`;
      reply += `250-uptime=${uptime}\r\n`;
      reply += '250-version=0.4.9.11\r\n';
      reply += '250 OK\r\n';
      sock.write(reply);
      if (DROP_AFTER && getinfoCount >= DROP_AFTER) {
        console.log('[mock] dropping connection after', getinfoCount, 'GETINFOs');
        sock.destroy();
      }
      return;
    }
    if (line.startsWith('QUIT')) {
      sock.write('250 closing connection\r\n');
      sock.end();
      return;
    }
    sock.write('510 Unrecognized command\r\n');
  }
});

server.listen(PORT, '127.0.0.1', () => console.log('[mock] control listening on', PORT));
