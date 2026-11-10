'use strict';
// One table of tools, shared by the HTTP API, the MCP server and the OpenAPI spec.
// `cmd` is the command sent to the extension; `method`/`path` is the HTTP route.

const target = {
  index: { type: 'integer', description: 'Element index from /read (the number in [N]). Preferred.' },
  x: { type: 'number', description: 'X in CSS pixels of the last screenshot (with y).' },
  y: { type: 'number', description: 'Y in CSS pixels of the last screenshot (with x).' },
};

const TOOLS = [
  {
    name: 'status',
    cmd: 'status',
    method: 'GET',
    path: '/status',
    description: 'Bridge and extension status: whether the extension is connected, the active tab, versions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tabs',
    cmd: 'tabs',
    method: 'GET',
    path: '/tabs',
    description: 'List open tabs (id, title, url, active, windowId).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'tab',
    cmd: 'tab',
    method: 'POST',
    path: '/tab',
    description:
      'Open a new tab (action "open" with url), switch to a tab ("switch" with tabId) or close one ("close" with tabId).',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['open', 'switch', 'close'] },
        url: { type: 'string' },
        tabId: { type: 'integer' },
      },
      required: ['action'],
    },
  },
  {
    name: 'navigate',
    cmd: 'navigate',
    method: 'POST',
    path: '/navigate',
    description: 'Navigate the active tab to a URL, or go back/forward/reload.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute URL (https://...).' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
      },
    },
  },
  {
    name: 'read',
    cmd: 'read',
    method: 'GET',
    path: '/read',
    description:
      'Read the active page: title, url, cleaned text, and indexed interactive elements ([N] role "name"). Call this before click/type; indexes are valid until the page changes.',
    inputSchema: {
      type: 'object',
      properties: {
        maxChars: { type: 'integer', description: 'Max characters of page text (default 20000).' },
        lite: { type: 'boolean', description: 'Lite mode: only the visible part of the page, shorter text.' },
        raw: { type: 'boolean', description: 'Also return the raw page outline.' },
      },
    },
  },
  {
    name: 'screenshot',
    cmd: 'screenshot',
    method: 'GET',
    path: '/screenshot',
    description:
      'PNG screenshot of the visible part of the active tab. HTTP: ?format=png for binary, default JSON with base64.',
    inputSchema: {
      type: 'object',
      properties: {
        labels: { type: 'boolean', description: 'Draw element labels on the image.' },
        fullPage: { type: 'boolean' },
      },
    },
  },
  {
    name: 'click',
    cmd: 'click',
    method: 'POST',
    path: '/click',
    description: 'Click an element by index (from read), or at x,y CSS-pixel coordinates of the last screenshot.',
    inputSchema: { type: 'object', properties: { ...target } },
  },
  {
    name: 'type',
    cmd: 'type',
    method: 'POST',
    path: '/type',
    description:
      'Type text into a field by index. Refuses password, payment and one-time-code fields: a human must fill those.',
    inputSchema: {
      type: 'object',
      properties: {
        index: target.index,
        text: { type: 'string' },
        enter: { type: 'boolean', description: 'Press Enter afterwards.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'scroll',
    cmd: 'scroll',
    method: 'POST',
    path: '/scroll',
    description: 'Scroll the page (or an element by index): direction up/down by pages, or to top/bottom.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'] },
        pages: { type: 'number', description: 'How many screens (default 1).' },
        to: { type: 'string', enum: ['top', 'bottom'] },
        index: target.index,
      },
    },
  },
  {
    name: 'key',
    cmd: 'key',
    method: 'POST',
    path: '/key',
    description: 'Press a key or chord, such as "Enter", "Escape", "Tab" or "Control+A".',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' }, index: target.index },
      required: ['keys'],
    },
  },
  {
    name: 'run_task',
    cmd: 'run_task',
    method: 'POST',
    path: '/run_task',
    description:
      "Run the extension's own AI agent on a natural-language task in the active tab, using the model chosen in the extension. Returns its final answer and steps.",
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        timeoutSec: { type: 'integer', description: 'Give up waiting after this many seconds (default 600).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'stop',
    cmd: 'stop',
    method: 'POST',
    path: '/stop',
    description: 'Stop a running run_task.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const byName = new Map(TOOLS.map(t => [t.name, t]));
const byRoute = new Map(TOOLS.map(t => [`${t.method} ${t.path}`, t]));

module.exports = { TOOLS, byName, byRoute };
