// End-to-end check with a real Chromium: the built extension (dist/), a real bridge, a test page, and the fixture
// server's fake OpenAI-compatible model for run_task. Needs: `pnpm build`, Chromium, an X display (xvfb-run).
//
//   xvfb-run -a node bridge/test/e2e-chromium.mjs [path-to-chromium]
//
// Puppeteer is used only to start Chromium and to write the extension's settings in its worker; every page action
// goes through the bridge's HTTP API, as an outside agent would do it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const puppeteer = require('puppeteer-core');
const chromePath = process.argv[2] || process.env.CHROME_PATH || '/usr/bin/chromium';
const dist = path.join(root, 'dist');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hark-e2e-'));
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ---- test page ----
const PAGE = `<!doctype html><html><head><title>Hark E2E Page</title></head><body>
<h1>Hark remote test</h1>
<p id="out">Nothing clicked yet.</p>
<button id="b" onclick="document.getElementById('out').textContent='Button was clicked!'">Press me</button>
<label>City <input id="city" type="text" name="city"></label>
<label>Password <input id="pw" type="password" name="pw"></label>
<label>Secret word <input id="sw" type="password" name="sw"></label>
<a href="/second">Go to second page</a>
<form action="/second" method="post" onsubmit="document.getElementById('out').textContent='FORM SUBMITTED'; return false;">
<label>Message <input id="msg" name="msg" value="hi"></label><button type="submit">Send message</button></form>
<div style="height:3000px"></div><p>Bottom of page</p>
</body></html>`;
const SECOND = `<!doctype html><title>Second Page</title><h1>Second page</h1><p>Welcome to page two.</p>`;
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(req.url.startsWith('/second') ? SECOND : PAGE);
});
await new Promise(r => site.listen(18080, '127.0.0.1', r));
const pageUrl = 'http://127.0.0.1:18080/';

// ---- fixture server (fake model) ----
const fixtures = spawn(process.execPath, [path.join(root, 'fixtures', 'server.mjs')], { stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1500));

// ---- bridge ----
process.env.HARK_BRIDGE_CONFIG = path.join(tmp, 'config.json');
const { Bridge, loadConfig } = require(path.join(root, 'bridge', 'bridge.js'));
const log = console.log;
console.log = () => {};
const config = loadConfig();
console.log = log;
config.logDir = path.join(tmp, 'logs');
config.httpHost = '127.0.0.1';
const bridge = new Bridge(config);
await bridge.start();
const token = config.tokens[0].token;
const api = async (p, body, method = body ? 'POST' : 'GET') => {
  const r = await fetch(`http://127.0.0.1:${config.httpPort}${p}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = r.headers.get('content-type') || '';
  return { status: r.status, body: type.startsWith('image/') ? Buffer.from(await r.arrayBuffer()) : await r.json() };
};

// ---- Chromium with the extension ----
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: false,
  pipe: true,
  userDataDir: path.join(tmp, 'profile'),
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',
    '--window-size=1280,900',
  ],
  ignoreDefaultArgs: ['--disable-extensions'],
});

let exitCode = 1;
try {
  const swTarget = await browser.waitForTarget(
    t => t.type() === 'service_worker' && t.url().endsWith('background.js'),
    {
      timeout: 20_000,
    },
  );
  const worker = await swTarget.worker();
  check('extension service worker started', !!worker, swTarget.url());

  // Close the welcome tab and open the test page as the active tab.
  await new Promise(r => setTimeout(r, 1500));
  for (const p of await browser.pages()) if (p.url().includes('welcome.html')) await p.close();
  const page = (await browser.pages())[0] ?? (await browser.newPage());
  await page.goto(pageUrl);
  await page.bringToFront();

  // Settings the user would enter: a provider on the fake model, Auto mode off (default Ask), remote on.
  await worker.evaluate(
    async (token, llm) => {
      await chrome.storage.local.set({
        'nb.providers': [
          { id: 'fake', kind: 'openai-compatible', name: 'Fake', baseUrl: llm, models: [{ name: 'fixture-model' }] },
        ],
        'nb.keys': { fake: 'test-key' },
      });
      const s = (await chrome.storage.local.get('nb.settings'))['nb.settings'] || {};
      await chrome.storage.local.set({
        'nb.settings': { ...s, defaultModel: { providerId: 'fake', model: 'fixture-model' }, onboarded: true },
      });
      await chrome.storage.local.set({
        'hark.remote.settings': { enabled: true, url: 'ws://127.0.0.1:17345', token, allowRunTask: true },
      });
    },
    config.extensionToken,
    'http://127.0.0.1:8787/__llm/v1',
  );

  // Wait for the connection.
  let status;
  for (let i = 0; i < 40; i++) {
    status = await api('/status');
    if (status.body.data?.extensionConnected && status.body.data.extension) break;
    await new Promise(r => setTimeout(r, 500));
  }
  check(
    'extension connected to bridge (/status)',
    !!status.body.data?.extensionConnected,
    JSON.stringify(status.body.data?.extension?.activeTab),
  );
  const remoteState = await worker.evaluate(
    async () => (await chrome.storage.local.get('hark.remote.status'))['hark.remote.status'],
  );
  check('worker status is connected', remoteState?.state === 'connected', remoteState?.state);
  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  check('toolbar badge shows R', badge === 'R', `badge="${badge}"`);

  const tabs = await api('/tabs');
  check(
    '/tabs lists the test page',
    tabs.body.data?.tabs?.some(t => t.url === pageUrl),
    `${tabs.body.data?.tabs?.length} tabs`,
  );

  const read = await api('/read');
  const els = read.body.data?.elements ?? [];
  check(
    '/read returns title, text and indexed elements',
    read.status === 200 && read.body.data?.title === 'Hark E2E Page' && els.length >= 3,
    `${els.length} elements: ${els
      .map(e => e.line)
      .join(' | ')
      .slice(0, 300)}`,
  );
  check(
    '/read text contains page text',
    /Nothing clicked yet/.test(read.body.data?.text ?? ''),
    (read.body.data?.text ?? read.body.error ?? '').slice(0, 120),
  );

  const shot = await api('/screenshot?format=png');
  const isPng = Buffer.isBuffer(shot.body) && shot.body.subarray(1, 4).toString() === 'PNG';
  check(
    '/screenshot returns a PNG',
    isPng,
    isPng ? `${shot.body.length} bytes` : JSON.stringify(shot.body).slice(0, 200),
  );
  if (isPng) fs.writeFileSync(path.join(here, '..', '..', 'e2e-screenshot.png'), shot.body);
  const shotJson = await api('/screenshot');
  check(
    '/screenshot JSON has base64',
    typeof shotJson.body.data?.base64 === 'string' && shotJson.body.data.width > 0,
    `${shotJson.body.data?.width}x${shotJson.body.data?.height}`,
  );

  const button = els.find(e => e.role === 'button' && /Press me/.test(e.name));
  const click = await api('/click', { index: button?.index });
  const after = await page.$eval('#out', n => n.textContent);
  check(
    '/click by index clicks the button',
    click.status === 200 && after === 'Button was clicked!',
    `status ${click.status}, page says "${after}" ${click.body.error ?? ''}`,
  );

  const city = els.find(e => /City/.test(e.name));
  const typed = await api('/type', { index: city?.index, text: 'Ranchi' });
  const cityValue = await page.$eval('#city', n => n.value);
  check(
    '/type into a text field',
    typed.status === 200 && cityValue === 'Ranchi',
    `status ${typed.status}, value "${cityValue}" ${typed.body.error ?? ''}`,
  );

  const pw = els.find(e => /Password/.test(e.name));
  const pwTyped = await api('/type', { index: pw?.index, text: 'hunter2' });
  const pwValue = await page.$eval('#pw', n => n.value);
  check(
    '/type refuses a password field',
    pwTyped.status !== 200 && pwValue === '',
    `status ${pwTyped.status} ${pwTyped.body.code}: ${pwTyped.body.error?.slice(0, 120)}`,
  );

  // A password field whose label says nothing: the bridge's name check passes it, the layer's secret-field gate refuses.
  const sw = els.find(e => /Secret word/.test(e.name));
  const swTyped = await api('/type', { index: sw?.index, text: 'hunter2' });
  const swValue = await page.$eval('#sw', n => n.value);
  check(
    '/type refuses an unlabelled password field (layer gate)',
    swTyped.status !== 200 && swValue === '',
    `status ${swTyped.status} ${swTyped.body.code}: ${swTyped.body.error?.slice(0, 160)}`,
  );

  // A submit in Ask mode needs a person: refused for a remote agent, nothing sent.
  const send = els.find(e => e.role === 'button' && /Send message/.test(e.name));
  const sent = await api('/click', { index: send?.index });
  const outAfterSend = await page.$eval('#out', n => n.textContent);
  check(
    'a submit in Ask mode is refused remotely (NEEDS_APPROVAL)',
    sent.status !== 200 && outAfterSend !== 'FORM SUBMITTED',
    `status ${sent.status} ${sent.body.code}: ${(sent.body.error ?? '').slice(0, 140)}`,
  );

  // Settings > Remote shows the connection and the agent's name.
  const opts = await browser.newPage();
  await opts.setViewport({ width: 1200, height: 1100 });
  await opts.goto(swTarget.url().replace('background.js', 'options.html#remote'));
  await new Promise(r => setTimeout(r, 1500));
  const optsText = await opts.evaluate(() => document.body.innerText);
  check(
    'Settings > Remote shows connected + agent name',
    /Remote control is active/.test(optsText) && /default/.test(optsText),
    optsText.match(/Agents using the bridge[\s\S]{0,80}/)?.[0]?.replace(/\n/g, ' '),
  );
  await opts.screenshot({ path: path.join(root, 'e2e-remote-settings.png') });
  const prov = await browser.newPage();
  await prov.setViewport({ width: 1200, height: 1400 });
  await prov.goto(swTarget.url().replace('background.js', 'options.html#providers'));
  await new Promise(r => setTimeout(r, 1200));
  const testBtn = await prov.$$eval('button', bs => bs.filter(b => b.textContent.trim() === 'Test connection').length);
  check('Providers card has a Test connection button', testBtn >= 1, `${testBtn} button(s)`);
  const pressTest = () =>
    prov.evaluate(() =>
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Test connection')?.click(),
    );
  // First with a model that answers in text: the exact problem is shown.
  await fetch('http://127.0.0.1:8787/__llm/reset', { method: 'POST' });
  await pressTest();
  await new Promise(r => setTimeout(r, 4000));
  const badText = await prov.evaluate(() => document.body.innerText);
  check(
    'Test connection reports "no tool calling" exactly',
    /did not call the test tool/.test(badText),
    badText.match(/fixture-model: [^\n]*/)?.[0],
  );
  // Then with a model that calls the test tool.
  await fetch('http://127.0.0.1:8787/__llm/script', {
    method: 'POST',
    body: JSON.stringify({ replies: [{ toolCalls: [{ name: 'report_status', input: { status: 'ok' } }] }] }),
  });
  await pressTest();
  await new Promise(r => setTimeout(r, 5000));
  const provText = await prov.evaluate(() => document.body.innerText);
  check(
    'Test connection shows OK and latency',
    /OK · \d+ ms · tool calling works/.test(provText),
    provText.match(/fixture-model: [^\n]*/)?.[0],
  );
  await prov.screenshot({ path: path.join(root, 'e2e-providers.png') });
  await prov.close();
  await opts.close();
  await page.bringToFront();

  const scroll = await api('/scroll', { direction: 'down', pages: 1 });
  const y = await page.evaluate(() => window.scrollY);
  check('/scroll scrolls the page', scroll.status === 200 && y > 100, `scrollY=${y} ${scroll.body.error ?? ''}`);

  const key = await api('/key', { keys: 'End' });
  check('/key presses a key', key.status === 200, key.body.error ?? '');

  const nav = await api('/navigate', { url: 'http://127.0.0.1:18080/second' });
  check(
    '/navigate goes to a URL',
    nav.status === 200 && nav.body.data?.title === 'Second Page',
    `${nav.body.data?.url} ${nav.body.error ?? ''}`,
  );
  const back = await api('/navigate', { action: 'back' });
  check('/navigate back', back.status === 200, back.body.data?.url ?? back.body.error);

  const opened = await api('/tab', { action: 'open', url: 'http://127.0.0.1:18080/second' });
  check('/tab open', opened.status === 200 && !!opened.body.data?.id, JSON.stringify(opened.body).slice(0, 160));
  if (opened.body.data?.id) {
    const closed = await api('/tab', { action: 'close', tabId: opened.body.data.id });
    check('/tab close', closed.status === 200, closed.body.error ?? '');
  }
  await page.bringToFront();

  // MCP: tools/list and a screenshot as image content.
  const mcp = async body => (await api('/mcp', body)).body;
  await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const mcpShot = await mcp({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'screenshot', arguments: {} },
  });
  check(
    'MCP screenshot returns image content',
    mcpShot.result?.content?.[0]?.type === 'image',
    mcpShot.result?.content?.[0]?.mimeType,
  );
  const mcpRead = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read', arguments: {} } });
  check(
    'MCP read returns indexed elements',
    /\[\d+\] button "Press me"/.test(mcpRead.result?.content?.[0]?.text ?? ''),
    (mcpRead.result?.content?.[0]?.text ?? '').slice(0, 100),
  );

  // run_task with the fake model: it answers with the done tool.
  await fetch('http://127.0.0.1:8787/__llm/reset', { method: 'POST' });
  await fetch('http://127.0.0.1:8787/__llm/script', {
    method: 'POST',
    body: JSON.stringify({
      replies: [
        { toolCalls: [{ name: 'done', input: { outcome: 'success', summary: 'The page title is Hark E2E Page.' } }] },
      ],
    }),
  });
  const task = await api('/run_task', { prompt: 'What is the title of this page?', timeoutSec: 60 });
  check(
    '/run_task runs the extension agent and returns its answer',
    task.status === 200 && task.body.data?.status === 'done',
    JSON.stringify(task.body.data ?? task.body).slice(0, 300),
  );

  // Disconnect from the UI side: remote off -> bridge sees the extension leave.
  await worker.evaluate(async () => {
    const s = (await chrome.storage.local.get('hark.remote.settings'))['hark.remote.settings'];
    await chrome.storage.local.set({ 'hark.remote.settings': { ...s, enabled: false } });
  });
  await new Promise(r => setTimeout(r, 1500));
  const off = await api('/status');
  check('turning remote off disconnects', off.body.data?.extensionConnected === false);
  const badgeOff = await worker.evaluate(() => chrome.action.getBadgeText({}));
  check('badge cleared after disconnect', badgeOff === '', `badge="${badgeOff}"`);

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  exitCode = failed.length ? 1 : 0;
} catch (error) {
  console.error('E2E error:', error);
} finally {
  await browser.close().catch(() => {});
  bridge.stop();
  site.close();
  fixtures.kill();
  fs.writeFileSync(path.join(tmp, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(exitCode);
}
