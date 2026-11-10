'use strict';
// The Python client (client/hark_remote.py) against a real bridge and a fake extension, directly and through a
// minimal SOCKS5 proxy (like tailscaled --socks5-server).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { connectClient } = require('../lib/ws');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-client-'));
process.env.HARK_BRIDGE_CONFIG = path.join(dir, 'config.json');
const { Bridge, loadConfig } = require('../bridge');
const CLIENT = path.join(__dirname, '..', '..', 'client', 'hark_remote.py');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let bridge,
  ext,
  socks,
  tokenFile,
  socksUsed = 0;

function py(args) {
  return new Promise(resolve =>
    execFile(
      'python3',
      [CLIENT, '--host', '127.0.0.1', '--port', '27446', '--token-file', tokenFile, ...args],
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    ),
  );
}

test.before(async () => {
  const log = console.log;
  console.log = () => {};
  const config = loadConfig();
  Object.assign(config, { wsPort: 27445, httpPort: 27446, httpHost: '127.0.0.1', logDir: path.join(dir, 'logs') });
  tokenFile = path.join(dir, 'token.txt');
  fs.writeFileSync(tokenFile, config.tokens[0].token + '\n');
  bridge = new Bridge(config);
  await bridge.start();
  console.log = log;
  ext = await connectClient('ws://127.0.0.1:27445');
  ext.on('message', t => {
    const m = JSON.parse(t);
    if (m.type !== 'cmd') return;
    const data =
      m.cmd === 'read'
        ? { title: 'T', url: 'https://x.test', text: 'Body text', elements: [{ index: 5, line: '[5] button "Go"' }] }
        : m.cmd === 'screenshot'
          ? { mimeType: 'image/png', base64: PNG.toString('base64'), width: 1, height: 1 }
          : { cmd: m.cmd, args: m.args };
    ext.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data }));
  });
  const ready = new Promise(r => ext.on('message', t => JSON.parse(t).type === 'welcome' && r()));
  ext.send(JSON.stringify({ type: 'hello', token: config.extensionToken }));
  await ready;

  // A minimal SOCKS5 server (no auth, CONNECT only).
  socks = net.createServer(client => {
    client.once('data', () => {
      client.write(Buffer.from([5, 0]));
      client.once('data', req => {
        let host, port;
        if (req[3] === 1) {
          host = [...req.subarray(4, 8)].join('.');
          port = req.readUInt16BE(8);
        } else if (req[3] === 3) {
          const len = req[4];
          host = req.subarray(5, 5 + len).toString();
          port = req.readUInt16BE(5 + len);
        }
        socksUsed++;
        const up = net.connect(port, host, () => {
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          client.pipe(up).pipe(client);
        });
        up.on('error', () => client.destroy());
      });
    });
  });
  await new Promise(r => socks.listen(27455, '127.0.0.1', r));
});

test.after(() => {
  ext.close();
  socks.close();
  bridge.stop();
});

test('status', async () => {
  const r = await py(['status']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).data.extensionConnected, true);
});

test('read prints elements', async () => {
  const r = await py(['read']);
  assert.match(r.stdout, /\[5\] button "Go"/);
  assert.match(r.stdout, /Body text/);
});

test('click, type, navigate, tabs, run, stop', async () => {
  assert.strictEqual(JSON.parse((await py(['click', '5'])).stdout).data.args.index, 5);
  const typed = JSON.parse((await py(['type', '5', 'hi there', '--enter'])).stdout).data.args;
  assert.deepStrictEqual(typed, { index: 5, text: 'hi there', enter: true });
  assert.strictEqual(JSON.parse((await py(['navigate', 'https://a.test'])).stdout).data.args.url, 'https://a.test');
  assert.strictEqual(JSON.parse((await py(['navigate', 'back'])).stdout).data.args.action, 'back');
  assert.strictEqual(JSON.parse((await py(['tabs'])).stdout).data.cmd, 'tabs');
  assert.strictEqual(JSON.parse((await py(['run', 'do it'])).stdout).data.args.prompt, 'do it');
  assert.strictEqual(JSON.parse((await py(['stop'])).stdout).data.cmd, 'stop');
});

test('screenshot saves a PNG', async () => {
  const out = path.join(dir, 'shot.png');
  const r = await py(['screenshot', out]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(fs.readFileSync(out), PNG);
});

test('through SOCKS5', async () => {
  const before = socksUsed;
  const r = await py(['--socks5', 'localhost:27455', 'status']);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).ok, true);
  const out = path.join(dir, 'shot2.png');
  await py(['--socks5', '127.0.0.1:27455', 'screenshot', out]);
  assert.deepStrictEqual(fs.readFileSync(out), PNG);
  assert.strictEqual(socksUsed, before + 2);
});

test('bad token exits non-zero', async () => {
  const bad = path.join(dir, 'bad.txt');
  fs.writeFileSync(bad, 'nope');
  const r = await new Promise(resolve =>
    execFile(
      'python3',
      [CLIENT, '--host', '127.0.0.1', '--port', '27446', '--token-file', bad, 'status'],
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }),
    ),
  );
  assert.strictEqual(r.code, 1);
  assert.match(r.stderr, /401/);
});
