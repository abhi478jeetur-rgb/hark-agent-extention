'use strict';
// End-to-end test of the bridge with a fake extension (a WebSocket client) and real HTTP/MCP requests.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { connectClient } = require('../lib/ws');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-bridge-'));
const configFile = path.join(dir, 'config.json');
const WS_PORT = 27345;
const HTTP_PORT = 27346;
process.env.HARK_BRIDGE_CONFIG = configFile;
const { Bridge, loadConfig } = require('../bridge');

let bridge;
let config;
let ext;
const received = [];
const base = `http://127.0.0.1:${HTTP_PORT}`;

function api(pathname, { method = 'GET', body, token = config.tokens[0].token } = {}) {
  return fetch(base + pathname, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test.before(async () => {
  // First run writes the config (silence its banner).
  const log = console.log;
  console.log = () => {};
  config = loadConfig();
  config.wsPort = WS_PORT;
  config.httpPort = HTTP_PORT;
  config.httpHost = '127.0.0.1';
  config.logDir = path.join(dir, 'logs');
  config.rateLimitPerMinute = 50;
  config.tokens.push({ name: 'claude', token: 'c'.repeat(43), revoked: false });
  config.tokens.push({ name: 'old', token: 'o'.repeat(43), revoked: true });
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  bridge = new Bridge(config);
  await bridge.start();
  console.log = log;
});

test.after(() => {
  ext && ext.close();
  bridge.stop();
});

test('config has 32+ char tokens', () => {
  assert.ok(config.extensionToken.length >= 32);
  assert.ok(config.tokens[0].token.length >= 32);
});

test('everything needs a token', async () => {
  for (const p of ['/status', '/openapi.json', '/mcp', '/read', '/nope']) {
    const r = await fetch(base + p);
    assert.strictEqual(r.status, 401, p);
  }
  assert.strictEqual((await api('/status', { token: 'wrong' })).status, 401);
  assert.strictEqual((await api('/status', { token: 'o'.repeat(43) })).status, 401, 'revoked token refused');
});

test('status without extension says not connected', async () => {
  const r = await api('/status');
  const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(j.data.extensionConnected, false);
  const read = await api('/read');
  assert.strictEqual(read.status, 503);
});

test('extension with a bad token is refused', async () => {
  const bad = await connectClient(`ws://127.0.0.1:${WS_PORT}`);
  const closed = new Promise(r => bad.on('close', r));
  bad.send(JSON.stringify({ type: 'hello', token: 'nope' }));
  assert.strictEqual(await closed, 4003);
});

test('fake extension connects and answers commands', async () => {
  ext = await connectClient(`ws://127.0.0.1:${WS_PORT}`);
  const welcome = new Promise(r =>
    ext.on('message', t => {
      const m = JSON.parse(t);
      if (m.type === 'welcome') r(m);
    }),
  );
  ext.on('message', t => {
    const m = JSON.parse(t);
    received.push(m);
    if (m.type !== 'cmd') return;
    const reply = data => ext.send(JSON.stringify({ type: 'result', id: m.id, ok: true, data }));
    switch (m.cmd) {
      case 'status':
        return reply({
          version: 'test',
          remote: 'on',
          activeTab: { id: 1, url: 'https://example.com', title: 'Example' },
        });
      case 'read':
        return reply({
          title: 'Example',
          url: 'https://example.com',
          text: 'Hello',
          elements: [{ index: 3, ref: 'e3', role: 'link', name: 'More', line: '[3] link "More"' }],
        });
      case 'screenshot':
        return reply({ mimeType: 'image/png', base64: PNG.toString('base64'), width: 1, height: 1 });
      case 'click':
        return reply({ clicked: m.args.index, agent: m.agent });
      case 'type':
        return ext.send(
          JSON.stringify({
            type: 'result',
            id: m.id,
            ok: false,
            code: 'SENSITIVE_FIELD',
            error: 'Password field: a human must type this.',
          }),
        );
      default:
        return reply({ cmd: m.cmd, args: m.args });
    }
  });
  ext.send(JSON.stringify({ type: 'hello', token: config.extensionToken, info: { version: 'test' } }));
  await welcome;
});

test('HTTP endpoints round-trip', async () => {
  const s = await (await api('/status')).json();
  assert.strictEqual(s.data.extensionConnected, true);
  assert.strictEqual(s.data.extension.activeTab.url, 'https://example.com');

  const read = await (await api('/read?maxChars=500')).json();
  assert.strictEqual(read.data.elements[0].index, 3);
  const readCmd = received.find(m => m.cmd === 'read');
  assert.strictEqual(readCmd.args.maxChars, 500);

  const click = await (await api('/click', { method: 'POST', body: { index: 3 } })).json();
  assert.deepStrictEqual(click.data, { clicked: 3, agent: 'default' });

  const typed = await api('/type', { method: 'POST', body: { index: 4, text: 'secret' } });
  assert.strictEqual(typed.status, 400);
  assert.strictEqual((await typed.json()).code, 'SENSITIVE_FIELD');

  const shotJson = await (await api('/screenshot')).json();
  assert.strictEqual(shotJson.data.base64, PNG.toString('base64'));
  const shot = await api('/screenshot?format=png');
  assert.strictEqual(shot.headers.get('content-type'), 'image/png');
  assert.deepStrictEqual(Buffer.from(await shot.arrayBuffer()), PNG);

  const nav = await (await api('/navigate', { method: 'POST', body: { url: 'https://example.org' } })).json();
  assert.strictEqual(nav.data.args.url, 'https://example.org');
});

test('agents list is pushed to the extension with names', async () => {
  await api('/status', { token: 'c'.repeat(43) });
  await new Promise(r => setTimeout(r, 100));
  const pushes = received.filter(m => m.type === 'agents');
  const last = pushes[pushes.length - 1];
  assert.ok(last.agents.some(a => a.name === 'claude'));
  assert.ok(last.agents.some(a => a.name === 'default'));
});

test('typed text is not written to the log', async () => {
  await new Promise(r => setTimeout(r, 100));
  const logs = fs.readdirSync(path.join(dir, 'logs'));
  const text = fs.readFileSync(path.join(dir, 'logs', logs[0]), 'utf8');
  assert.ok(text.includes('"tool":"type"'));
  assert.ok(!text.includes('secret'));
  assert.ok(text.includes('<6 chars>'));
});

test('openapi spec lists the tools', async () => {
  const spec = await (await api('/openapi.json')).json();
  assert.strictEqual(spec.openapi, '3.0.3');
  for (const p of ['/status', '/read', '/click', '/type', '/run_task', '/screenshot']) assert.ok(spec.paths[p], p);
});

test('MCP over Streamable HTTP', async () => {
  const rpc = async body => {
    const r = await api('/mcp', { method: 'POST', body });
    return r.status === 202 ? null : r.json();
  };
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
  });
  assert.strictEqual(init.result.protocolVersion, '2025-03-26');
  assert.strictEqual(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map(t => t.name);
  for (const n of [
    'status',
    'tabs',
    'navigate',
    'read',
    'screenshot',
    'click',
    'type',
    'scroll',
    'key',
    'run_task',
    'stop',
  ])
    assert.ok(names.includes(n), n);
  const shot = await rpc({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'screenshot', arguments: {} },
  });
  assert.strictEqual(shot.result.content[0].type, 'image');
  assert.strictEqual(shot.result.content[0].mimeType, 'image/png');
  const read = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read', arguments: {} } });
  assert.match(read.result.content[0].text, /\[3\] link "More"/);
  const typed = await rpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'type', arguments: { index: 1, text: 'x' } },
  });
  assert.strictEqual(typed.result.isError, true);
});

test('MCP over stdio proxies to the bridge', async () => {
  const child = spawn(process.execPath, [
    path.join(__dirname, '..', 'bridge.js'),
    '--mcp-stdio',
    '--remote',
    base,
    '--token',
    'c'.repeat(43),
  ]);
  const lines = [];
  child.stdout.on('data', d => lines.push(...d.toString().split('\n').filter(Boolean)));
  child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n',
  );
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'click', arguments: { index: 3 } },
    }) + '\n',
  );
  child.stdin.end();
  await new Promise(r => child.on('exit', r));
  assert.strictEqual(lines.length, 2);
  assert.strictEqual(JSON.parse(lines[0]).result.serverInfo.name, 'hark-browser-bridge');
  assert.match(JSON.parse(lines[1]).result.content[0].text, /"clicked": 3/);
});

test('revoking a token in config.json takes effect without restart', async () => {
  const fresh = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  fresh.tokens.find(t => t.name === 'claude').revoked = true;
  await new Promise(r => setTimeout(r, 50));
  fs.writeFileSync(configFile, JSON.stringify(fresh, null, 2));
  await new Promise(r => setTimeout(r, 4500));
  assert.strictEqual((await api('/status', { token: 'c'.repeat(43) })).status, 401);
});

test('rate limit returns 429', async () => {
  let last;
  for (let i = 0; i < 60; i++) last = await api('/tabs');
  assert.strictEqual(last.status, 429);
});
