#!/usr/bin/env node
'use strict';
// Hark Bridge: lets an outside agent (Hark, Claude, Codex, Cursor, n8n, scripts) drive the Hark Browser Agent
// extension in the user's Chrome.
//
//   extension  <-- ws://127.0.0.1:17345 (extension token) -->  bridge  <-- http://0.0.0.0:17346 (agent tokens) -- agents
//
// No dependencies: Node 18+ standard library only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { upgrade } = require('./lib/ws');
const { TOOLS, byName, byRoute } = require('./lib/tools');
const { openapi } = require('./lib/openapi');
const mcp = require('./lib/mcp');

const VERSION = require('./package.json').version;
const ROOT = __dirname;

// ---------------------------------------------------------------------------------------------------------------
// Config

function configPath() {
  return process.env.HARK_BRIDGE_CONFIG || path.join(ROOT, 'config.json');
}

function newToken() {
  // 32 random bytes as base64url: 43 characters.
  return crypto.randomBytes(32).toString('base64url');
}

const DEFAULTS = {
  wsHost: '127.0.0.1',
  wsPort: 17345,
  httpHost: '0.0.0.0',
  httpPort: 17346,
  rateLimitPerMinute: 120,
  runTaskPerMinute: 6,
  runTaskTimeoutSec: 600,
  commandTimeoutSec: 60,
  allowRunTask: true,
  logDir: 'logs',
};

function loadConfig({ create = true } = {}) {
  const file = configPath();
  if (!fs.existsSync(file)) {
    if (!create) throw new Error(`No config at ${file}. Run the bridge once to create it.`);
    const config = {
      ...DEFAULTS,
      extensionToken: newToken(),
      tokens: [{ name: 'default', token: newToken(), revoked: false, createdAt: new Date().toISOString() }],
    };
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
    printFirstRun(config, file);
    return config;
  }
  const config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  if (!config.extensionToken || !Array.isArray(config.tokens)) throw new Error(`${file} is missing tokens`);
  return config;
}

function saveConfig(config) {
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

function printFirstRun(config, file) {
  const line = '='.repeat(72);
  console.log(`\n${line}\n Hark Bridge: first run. Tokens were created and saved in:\n   ${file}\n`);
  console.log(' 1) EXTENSION TOKEN - paste into the extension: Settings > Remote > Bridge token');
  console.log(`      ${config.extensionToken}\n`);
  console.log(' 2) AGENT TOKEN "default" - give this to the agent (Hark, Claude, scripts...)');
  console.log(`      ${config.tokens[0].token}\n`);
  console.log(' These are shown only once. Add more agent tokens with:  node bridge.js token add <name>');
  console.log(` Revoke one with:  node bridge.js token revoke <name>\n${line}\n`);
}

// ---------------------------------------------------------------------------------------------------------------
// Token CLI

function tokenCli(args) {
  const [action, name] = args;
  const config = loadConfig();
  const find = () => config.tokens.find(t => t.name === name);
  switch (action) {
    case 'list':
      for (const t of config.tokens)
        console.log(`${t.name.padEnd(20)} ${t.revoked ? 'REVOKED' : 'active '}  created ${t.createdAt || '?'}`);
      return;
    case 'add': {
      if (!name || !/^[\w.-]{1,40}$/.test(name)) throw new Error('Usage: token add <name>  (letters, digits, . _ -)');
      if (find()) throw new Error(`A token named "${name}" exists. Revoke it or pick another name.`);
      const token = newToken();
      config.tokens.push({ name, token, revoked: false, createdAt: new Date().toISOString() });
      saveConfig(config);
      console.log(`Agent token "${name}" (shown once):\n${token}`);
      return;
    }
    case 'revoke':
    case 'unrevoke': {
      const t = find();
      if (!t) throw new Error(`No token named "${name}"`);
      t.revoked = action === 'revoke';
      saveConfig(config);
      console.log(
        `${name}: ${t.revoked ? 'revoked' : 'active again'}. A running bridge picks this up within a few seconds.`,
      );
      return;
    }
    case 'remove': {
      if (!find()) throw new Error(`No token named "${name}"`);
      config.tokens = config.tokens.filter(t => t.name !== name);
      saveConfig(config);
      console.log(`${name}: removed.`);
      return;
    }
    case 'rotate-extension': {
      config.extensionToken = newToken();
      saveConfig(config);
      console.log(`New extension token (paste it into Settings > Remote):\n${config.extensionToken}`);
      return;
    }
    default:
      console.log(
        'Usage: node bridge.js token list|add <name>|revoke <name>|unrevoke <name>|remove <name>|rotate-extension',
      );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

class Logger {
  constructor(dir) {
    this.dir = path.isAbsolute(dir) ? dir : path.join(ROOT, dir);
    fs.mkdirSync(this.dir, { recursive: true });
  }
  write(entry) {
    const now = new Date();
    const file = path.join(this.dir, `bridge-${now.toISOString().slice(0, 10)}.log`);
    fs.appendFile(file, JSON.stringify({ at: now.toISOString(), ...entry }) + '\n', () => {});
  }
}

/** What is logged of a command's arguments: typed text is reduced to its length. */
function loggable(args) {
  if (!args || typeof args !== 'object') return args;
  const copy = { ...args };
  if (typeof copy.text === 'string') copy.text = `<${copy.text.length} chars>`;
  if (typeof copy.prompt === 'string' && copy.prompt.length > 300) copy.prompt = copy.prompt.slice(0, 300) + '…';
  return copy;
}

class RateLimiter {
  constructor() {
    this.hits = new Map();
  }
  allow(key, perMinute) {
    const now = Date.now();
    const list = (this.hits.get(key) || []).filter(t => now - t < 60_000);
    if (list.length >= perMinute) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(text);
}

// ---------------------------------------------------------------------------------------------------------------
// The bridge

class Bridge {
  constructor(config) {
    this.config = config;
    this.logger = new Logger(config.logDir);
    this.limiter = new RateLimiter();
    this.ext = null; // { conn, info, since }
    this.pending = new Map();
    this.agents = new Map(); // name -> { name, lastSeen, lastCommand, ip, via }
    this.nextId = 1;
    this.startedAt = new Date().toISOString();
  }

  /** Re-reads config.json so revoked tokens stop working without a restart. */
  watchConfig() {
    const file = configPath();
    let last = 0;
    this.configTimer = setInterval(() => {
      try {
        const m = fs.statSync(file).mtimeMs;
        if (m !== last) {
          if (last) {
            const fresh = loadConfig({ create: false });
            this.config.tokens = fresh.tokens;
            this.config.extensionToken = fresh.extensionToken;
            this.config.rateLimitPerMinute = fresh.rateLimitPerMinute;
            this.config.allowRunTask = fresh.allowRunTask;
          }
          last = m;
        }
      } catch {
        /* keep the old config */
      }
    }, 2000);
    this.configTimer.unref();
  }

  agentFor(header) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(header || '');
    if (!m) return null;
    const found = this.config.tokens.find(t => !t.revoked && t.token && safeEqual(t.token, m[1]));
    return found ? found.name : null;
  }

  // ---- extension side ----

  startWs() {
    const server = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('WebSocket only');
    });
    server.on('upgrade', (req, socket) => {
      // Only a Chrome extension (or a local test client without Origin) may connect.
      const conn = upgrade(req, socket, origin => !origin || /^chrome-extension:\/\//.test(origin));
      if (!conn) return;
      this.onExtensionSocket(conn);
    });
    return new Promise(resolve =>
      server.listen(this.config.wsPort, this.config.wsHost, () => {
        this.wsServer = server;
        resolve(server);
      }),
    );
  }

  onExtensionSocket(conn) {
    let authed = false;
    const helloTimer = setTimeout(() => !authed && conn.close(4001, 'hello timeout'), 5000);
    conn.on('message', text => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return conn.close(4002, 'bad json');
      }
      if (!authed) {
        if (msg.type !== 'hello' || !safeEqual(msg.token || '', this.config.extensionToken)) {
          this.logger.write({ event: 'extension_rejected' });
          conn.send(JSON.stringify({ type: 'error', error: 'Bad extension token' }));
          return conn.close(4003, 'bad token');
        }
        authed = true;
        clearTimeout(helloTimer);
        if (this.ext) this.ext.conn.close(4004, 'replaced by a new connection');
        this.ext = { conn, info: msg.info || {}, since: new Date().toISOString() };
        conn.send(JSON.stringify({ type: 'welcome', bridgeVersion: VERSION }));
        this.pushAgents();
        this.logger.write({ event: 'extension_connected', info: msg.info });
        console.log(`[bridge] extension connected (${(msg.info && msg.info.version) || '?'})`);
        return;
      }
      if (msg.type === 'result' && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.resolve(msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error, code: msg.code });
      } else if (msg.type === 'pong' || msg.type === 'ping') {
        if (msg.type === 'ping') conn.send(JSON.stringify({ type: 'pong' }));
      }
    });
    conn.on('close', () => {
      clearTimeout(helloTimer);
      if (this.ext && this.ext.conn === conn) {
        this.ext = null;
        console.log('[bridge] extension disconnected');
        this.logger.write({ event: 'extension_disconnected' });
        for (const [id, p] of this.pending) {
          clearTimeout(p.timer);
          p.resolve({ ok: false, code: 'EXTENSION_DISCONNECTED', error: 'The extension disconnected.' });
          this.pending.delete(id);
        }
      }
    });
    conn.on('error', () => {});
  }

  startKeepalive() {
    // App-level pings keep the extension's MV3 service worker alive (Chrome 116+ counts WebSocket traffic).
    this.keepalive = setInterval(() => {
      if (this.ext) {
        this.ext.conn.send(JSON.stringify({ type: 'ping', at: Date.now() }));
        this.ext.conn.ping();
      }
    }, 20_000);
    this.keepalive.unref();
  }

  pushAgents() {
    if (!this.ext) return;
    const agents = [...this.agents.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)).slice(0, 10);
    this.ext.conn.send(JSON.stringify({ type: 'agents', agents }));
  }

  noteAgent(name, ip, via, command) {
    const prev = this.agents.get(name);
    const now = new Date().toISOString();
    this.agents.set(name, { name, ip, via, lastSeen: now, lastCommand: command });
    // Pushed on a new agent or a new command, at most every 2 s per agent.
    if (!prev || Date.parse(now) - Date.parse(prev.pushedAt || 0) > 2000 || prev.lastCommand !== command) {
      this.agents.get(name).pushedAt = now;
      this.pushAgents();
    }
  }

  /** Sends one command to the extension and waits for its result. */
  command(cmd, args, agent) {
    if (!this.ext) {
      return Promise.resolve({
        ok: false,
        code: 'EXTENSION_NOT_CONNECTED',
        error:
          'The extension is not connected. In Chrome: Hark Browser Agent > Settings > Remote, turn Remote control on.',
      });
    }
    const id = String(this.nextId++);
    const timeoutSec =
      cmd === 'run_task'
        ? Math.min(Number(args.timeoutSec) || this.config.runTaskTimeoutSec, 3600) + 15
        : this.config.commandTimeoutSec;
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, code: 'TIMEOUT', error: `No answer from the extension within ${timeoutSec} s.` });
      }, timeoutSec * 1000);
      this.pending.set(id, { resolve, timer });
      this.ext.conn.send(JSON.stringify({ type: 'cmd', id, cmd, args, agent }));
    });
  }

  /** Every tool call from HTTP or MCP goes through here: rate limit, extension call, log. */
  async callTool(name, args, agent, meta) {
    const tool = byName.get(name);
    const start = Date.now();
    let result;
    if (!tool) result = { ok: false, code: 'UNKNOWN_TOOL', error: `Unknown tool ${name}` };
    else if (!this.limiter.allow(agent, this.config.rateLimitPerMinute))
      result = { ok: false, code: 'RATE_LIMITED', error: 'Too many requests; slow down.' };
    else if (name === 'run_task' && !this.config.allowRunTask)
      result = { ok: false, code: 'DISABLED', error: 'run_task is disabled in bridge/config.json (allowRunTask).' };
    else if (name === 'run_task' && !this.limiter.allow(`${agent}:run_task`, this.config.runTaskPerMinute))
      result = { ok: false, code: 'RATE_LIMITED', error: 'Too many run_task calls; wait a minute.' };
    else {
      this.noteAgent(agent, meta.ip, meta.via, name);
      result = await this.command(tool.cmd, args || {}, agent);
      if (name === 'status') {
        result = {
          ok: true,
          data: {
            bridge: { version: VERSION, startedAt: this.startedAt, agent },
            extensionConnected: !!this.ext,
            extension: result.ok ? result.data : null,
            ...(result.ok ? {} : { extensionError: result.error }),
          },
        };
      }
    }
    this.logger.write({
      agent,
      ip: meta.ip,
      via: meta.via,
      tool: name,
      args: loggable(args),
      ok: result.ok,
      code: result.code,
      error: result.ok ? undefined : result.error,
      ms: Date.now() - start,
    });
    return result;
  }

  // ---- agent side ----

  startHttp() {
    const server = http.createServer((req, res) => {
      this.onHttp(req, res).catch(err => {
        if (!res.headersSent) sendJson(res, err.status || 500, { ok: false, error: err.message });
      });
    });
    server.requestTimeout = 0; // run_task may take minutes
    server.headersTimeout = 30_000;
    return new Promise(resolve =>
      server.listen(this.config.httpPort, this.config.httpHost, () => {
        this.httpServer = server;
        resolve(server);
      }),
    );
  }

  async onHttp(req, res) {
    const url = new URL(req.url, 'http://bridge');
    const ip = req.socket.remoteAddress;
    const agent = this.agentFor(req.headers.authorization);
    if (!agent) {
      this.logger.write({ event: 'unauthorized', ip, path: url.pathname });
      // Same answer for a missing and a wrong token; slows down guessing a little.
      await new Promise(r => setTimeout(r, 300));
      return sendJson(
        res,
        401,
        { ok: false, error: 'Missing or invalid bearer token' },
        { 'WWW-Authenticate': 'Bearer' },
      );
    }

    if (url.pathname === '/openapi.json' && req.method === 'GET') {
      const host = req.headers.host || `localhost:${this.config.httpPort}`;
      return sendJson(res, 200, openapi(`http://${host}`, VERSION));
    }

    if (url.pathname === '/mcp') return this.onMcp(req, res, agent, ip);

    const tool = byRoute.get(`${req.method} ${url.pathname}`);
    if (!tool) return sendJson(res, 404, { ok: false, error: `No route ${req.method} ${url.pathname}` });

    let args = {};
    if (req.method === 'GET') {
      for (const [k, v] of url.searchParams) {
        if (k === 'format') continue;
        const schema = tool.inputSchema.properties[k];
        if (!schema) continue;
        args[k] =
          schema.type === 'integer' || schema.type === 'number'
            ? Number(v)
            : schema.type === 'boolean'
              ? v === 'true' || v === '1'
              : v;
      }
    } else {
      const body = await readBody(req);
      try {
        args = body ? JSON.parse(body) : {};
      } catch {
        return sendJson(res, 400, { ok: false, error: 'Body must be JSON' });
      }
    }
    const result = await this.callTool(tool.name, args, agent, { ip, via: 'http' });
    if (tool.name === 'screenshot' && result.ok && url.searchParams.get('format') === 'png') {
      const png = Buffer.from(result.data.base64, 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
      return res.end(png);
    }
    const status = result.ok
      ? 200
      : result.code === 'RATE_LIMITED'
        ? 429
        : result.code === 'EXTENSION_NOT_CONNECTED' || result.code === 'EXTENSION_DISCONNECTED'
          ? 503
          : result.code === 'TIMEOUT'
            ? 504
            : 400;
    return sendJson(res, status, result);
  }

  async onMcp(req, res, agent, ip) {
    if (req.method === 'GET') {
      // No server-initiated stream: this server answers every request with JSON.
      res.writeHead(405, { Allow: 'POST, DELETE' });
      return res.end();
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      return res.end();
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST, DELETE' });
      return res.end();
    }
    const body = await readBody(req);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const ctx = {
      serverVersion: VERSION,
      callTool: (name, args) => this.callTool(name, args, agent, { ip, via: 'mcp' }),
    };
    const sessionId = req.headers['mcp-session-id'] || crypto.randomUUID();
    const headers = { 'Mcp-Session-Id': sessionId };
    if (Array.isArray(payload)) {
      const out = (await Promise.all(payload.map(m => mcp.handleMessage(m, ctx)))).filter(Boolean);
      if (!out.length) {
        res.writeHead(202, headers);
        return res.end();
      }
      return sendJson(res, 200, out, headers);
    }
    const reply = await mcp.handleMessage(payload, ctx);
    if (!reply) {
      res.writeHead(202, headers);
      return res.end();
    }
    return sendJson(res, 200, reply, headers);
  }

  async start() {
    await this.startWs();
    await this.startHttp();
    this.startKeepalive();
    this.watchConfig();
    const active = this.config.tokens.filter(t => !t.revoked).map(t => t.name);
    console.log(`[bridge] Hark Bridge ${VERSION}`);
    console.log(`[bridge] extension socket  ws://${this.config.wsHost}:${this.config.wsPort}`);
    console.log(
      `[bridge] agent API         http://${this.config.httpHost}:${this.config.httpPort}  (MCP at /mcp, spec at /openapi.json)`,
    );
    console.log(`[bridge] active agent tokens: ${active.join(', ') || '(none)'}`);
    console.log(`[bridge] logs in ${this.logger.dir}`);
  }

  stop() {
    clearInterval(this.keepalive);
    clearInterval(this.configTimer);
    this.wsServer && this.wsServer.close();
    this.httpServer && this.httpServer.close();
    if (this.ext) this.ext.conn.close(1001, 'bridge stopping');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// MCP over stdio: a local proxy to a remote bridge's /mcp, for clients that only speak stdio.

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function mcpStdio(argv) {
  const remote = (argValue(argv, '--remote') || process.env.HARK_BRIDGE_URL || '').replace(/\/+$/, '');
  let token = argValue(argv, '--token') || process.env.HARK_BRIDGE_TOKEN;
  const tokenFile = argValue(argv, '--token-file');
  if (!token && tokenFile) token = fs.readFileSync(tokenFile, 'utf8').trim();
  if (!remote || !token) {
    process.stderr.write('Usage: node bridge.js --mcp-stdio --remote http://<tailscale-ip>:17346 --token <token>\n');
    process.exit(2);
  }
  let sessionId;
  const readline = require('node:readline');
  const rl = readline.createInterface({ input: process.stdin });
  const write = obj => process.stdout.write(JSON.stringify(obj) + '\n');
  let queue = Promise.resolve();
  rl.on('line', line => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
      try {
        const res = await fetch(`${remote}/mcp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${token}`,
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
          },
          body: JSON.stringify(msg),
        });
        sessionId = res.headers.get('mcp-session-id') || sessionId;
        if (res.status === 202) return;
        const text = await res.text();
        if (!res.ok && msg.id !== undefined) {
          return write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: `Bridge HTTP ${res.status}: ${text.slice(0, 300)}` },
          });
        }
        if (text) process.stdout.write(text.trim() + '\n');
      } catch (err) {
        if (msg.id !== undefined)
          write({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: `Cannot reach the bridge at ${remote}: ${err.message}` },
          });
      }
    });
  });
  rl.on('close', () => queue.then(() => process.exit(0)));
}

// ---------------------------------------------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--mcp-stdio')) return mcpStdio(argv);
  if (argv[0] === 'token') return tokenCli(argv.slice(1));
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(`Hark Bridge ${VERSION}
  node bridge.js                      start the bridge (creates config.json and tokens on first run)
  node bridge.js token list|add <name>|revoke <name>|unrevoke <name>|remove <name>|rotate-extension
  node bridge.js --mcp-stdio --remote http://<ip>:17346 --token <token>   MCP over stdio, proxied to a bridge`);
    return;
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error('Hark Bridge needs Node.js 18 or newer.');
    process.exit(1);
  }
  const bridge = new Bridge(loadConfig());
  await bridge.start();
  const shutdown = () => {
    console.log('\n[bridge] stopping');
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[bridge] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { Bridge, loadConfig, newToken, TOOLS };
