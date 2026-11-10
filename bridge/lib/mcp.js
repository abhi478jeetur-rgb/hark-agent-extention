'use strict';
// MCP (Model Context Protocol) server logic: JSON-RPC 2.0 over Streamable HTTP (JSON responses) or stdio.
const { TOOLS, byName } = require('./tools');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Turns a bridge result into MCP tool content. */
function toContent(name, result) {
  if (!result.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error${result.code ? ` (${result.code})` : ''}: ${result.error}` }],
    };
  }
  const data = result.data;
  if (name === 'screenshot' && data && data.base64) {
    return {
      content: [
        { type: 'image', data: data.base64, mimeType: data.mimeType || 'image/png' },
        { type: 'text', text: `Screenshot ${data.width}x${data.height} of ${data.url || 'the active tab'}` },
      ],
    };
  }
  if (name === 'read' && data && typeof data.text === 'string') {
    const lines = [`Title: ${data.title}`, `URL: ${data.url}`, '', 'Interactive elements:'];
    for (const el of data.elements || []) lines.push(el.line);
    lines.push('', 'Page text:', data.text);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  return { content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }] };
}

/**
 * Handles one JSON-RPC message. Returns the response object, or null for a notification.
 * `callTool(name, args)` resolves to { ok, data?, error?, code? }.
 */
async function handleMessage(message, { callTool, serverVersion }) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (message && message.id !== undefined && (message.result !== undefined || message.error !== undefined))
      return null; // a response from the client; nothing to do
    return rpcError(message && message.id, -32600, 'Invalid Request');
  }
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  if (isNotification) return null;
  switch (method) {
    case 'initialize': {
      const asked = params && params.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'hark-browser-bridge', version: serverVersion },
          instructions:
            "Controls the user's real Chrome browser. Use read to see the page with indexed elements, then click/type by index, then read again. Never try to enter passwords, payment details or one-time codes: ask the human.",
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return {
        jsonrpc: '2.0',
        id,
        result: {
          tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      };
    case 'tools/call': {
      const name = params && params.name;
      if (!byName.has(name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const result = await callTool(name, (params && params.arguments) || {});
      return { jsonrpc: '2.0', id, result: toContent(name, result) };
    }
    case 'resources/list':
      return { jsonrpc: '2.0', id, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id, result: { prompts: [] } };
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

module.exports = { handleMessage, toContent, PROTOCOL_VERSIONS };
