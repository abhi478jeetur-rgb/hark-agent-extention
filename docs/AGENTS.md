# Connecting AI agents to the Hark Bridge

Any agent can drive your Chrome through the bridge: over **MCP** (Claude Desktop, Claude Code, Codex CLI, Cursor,
anything that speaks MCP), over the **HTTP API** described by **OpenAPI** (n8n, function-calling agents, scripts),
or with the Python client (`client/hark_remote.py`).

Replace in every snippet:

- `100.x.y.z` – your laptop's Tailscale IP (`tailscale ip -4` on the laptop)
- `HARK_TOKEN` – an **agent token**. Make one per agent so you can revoke it alone:
  `node bridge.js token add claude-desktop` → prints the token once.

Every endpoint needs `Authorization: Bearer <token>` (also `/mcp` and `/openapi.json`). The agent's name (the
token's name) shows in the extension under Settings → Remote → *Agents using the bridge*.

Endpoints on `http://100.x.y.z:17346`:

| Purpose | URL |
| --- | --- |
| MCP (Streamable HTTP, JSON responses) | `POST /mcp` |
| OpenAPI 3 spec | `GET /openapi.json` |
| REST tools | `GET /status`, `GET /tabs`, `POST /tab`, `POST /navigate`, `GET /read`, `GET /screenshot`, `POST /click`, `POST /type`, `POST /scroll`, `POST /key`, `POST /run_task`, `POST /stop` |

MCP tools: `status`, `tabs`, `tab`, `navigate`, `read`, `screenshot` (image content), `click`, `type`, `scroll`,
`key`, `run_task`, `stop`. The loop that works best: **read → click/type by index → read again**.

## Two ways to connect over MCP

1. **HTTP (preferred)** – the client talks to `http://100.x.y.z:17346/mcp` with the bearer header.
2. **stdio proxy** – for clients that only launch local commands. Copy the `bridge/` folder (it has no
   dependencies) to the agent's machine and run it in proxy mode; it forwards MCP to the remote bridge:

   ```bash
   node /path/to/bridge/bridge.js --mcp-stdio --remote http://100.x.y.z:17346 --token HARK_TOKEN
   ```

   You can pass the token as the environment variable `HARK_BRIDGE_TOKEN` (and the URL as `HARK_BRIDGE_URL`)
   instead of flags, or `--token-file <path>`.

The agent's machine must be on the same tailnet (or route through Tailscale's SOCKS5 proxy, see SETUP.md).

## Claude Desktop

Settings → Developer → Edit Config (`claude_desktop_config.json`; Windows: `%APPDATA%\Claude\`, macOS:
`~/Library/Application Support/Claude/`):

```json
{
  "mcpServers": {
    "hark-browser": {
      "command": "node",
      "args": ["C:\\Hark\\bridge\\bridge.js", "--mcp-stdio", "--remote", "http://100.x.y.z:17346"],
      "env": { "HARK_BRIDGE_TOKEN": "HARK_TOKEN" }
    }
  }
}
```

Restart Claude Desktop. (On a paid plan you can instead add a custom connector with the URL
`http://100.x.y.z:17346/mcp` if your Claude Desktop version lets you set an Authorization header; the stdio
config above works everywhere.)

## Claude Code

HTTP:

```bash
claude mcp add --transport http hark-browser http://100.x.y.z:17346/mcp \
  --header "Authorization: Bearer HARK_TOKEN"
```

or stdio:

```bash
claude mcp add hark-browser --env HARK_BRIDGE_TOKEN=HARK_TOKEN -- \
  node /path/to/bridge/bridge.js --mcp-stdio --remote http://100.x.y.z:17346
```

Check with `claude mcp list`, then ask: *"Use hark-browser to read the current page."*

## Codex CLI

`~/.codex/config.toml` – stdio (works in every Codex version):

```toml
[mcp_servers.hark-browser]
command = "node"
args = ["/path/to/bridge/bridge.js", "--mcp-stdio", "--remote", "http://100.x.y.z:17346"]
env = { HARK_BRIDGE_TOKEN = "HARK_TOKEN" }
```

Codex versions with Streamable HTTP support can use the URL directly instead:

```toml
[mcp_servers.hark-browser]
url = "http://100.x.y.z:17346/mcp"
bearer_token_env_var = "HARK_BRIDGE_TOKEN"   # export HARK_BRIDGE_TOKEN=HARK_TOKEN before starting codex
```

## Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "hark-browser": {
      "url": "http://100.x.y.z:17346/mcp",
      "headers": { "Authorization": "Bearer HARK_TOKEN" }
    }
  }
}
```

stdio alternative:

```json
{
  "mcpServers": {
    "hark-browser": {
      "command": "node",
      "args": ["/path/to/bridge/bridge.js", "--mcp-stdio", "--remote", "http://100.x.y.z:17346"],
      "env": { "HARK_BRIDGE_TOKEN": "HARK_TOKEN" }
    }
  }
}
```

## Any MCP client (generic)

- Transport: Streamable HTTP, `POST http://100.x.y.z:17346/mcp`, header `Authorization: Bearer HARK_TOKEN`,
  `Content-Type: application/json`, `Accept: application/json, text/event-stream`. The server answers with JSON
  (no SSE stream; `GET /mcp` returns 405). Protocol versions 2025-06-18, 2025-03-26 and 2024-11-05.
- Or stdio with the proxy command above.

## n8n / function-calling agents (OpenAPI)

- Import `http://100.x.y.z:17346/openapi.json` (send the bearer header when fetching it, or download it once with
  curl and import the file).
- In n8n: **HTTP Request** node, Authentication → *Generic Credential Type* → *Header Auth*, name
  `Authorization`, value `Bearer HARK_TOKEN`. Or the **MCP Client Tool** node with the `/mcp` URL and the same
  header.

## curl

```bash
H="Authorization: Bearer HARK_TOKEN"; B=http://100.x.y.z:17346

curl -s -H "$H" $B/status
curl -s -H "$H" "$B/read?maxChars=4000"
curl -s -H "$H" "$B/screenshot?format=png" -o page.png
curl -s -H "$H" -H "Content-Type: application/json" -d '{"index": 12}' $B/click
curl -s -H "$H" -H "Content-Type: application/json" -d '{"index": 7, "text": "hello", "enter": true}' $B/type
curl -s -H "$H" -H "Content-Type: application/json" -d '{"url": "https://example.com"}' $B/navigate
curl -s -H "$H" -H "Content-Type: application/json" -d '{"direction": "down", "pages": 1}' $B/scroll
curl -s -H "$H" -H "Content-Type: application/json" -d '{"keys": "Escape"}' $B/key
curl -s -H "$H" -H "Content-Type: application/json" -d '{"action": "open", "url": "https://news.ycombinator.com"}' $B/tab
curl -s -H "$H" -H "Content-Type: application/json" -d '{"prompt": "Summarise this page in 3 bullets", "timeoutSec": 300}' $B/run_task
curl -s -H "$H" -X POST $B/stop

# MCP by hand
curl -s -H "$H" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' $B/mcp
```

Through Tailscale's userspace SOCKS5 proxy (Hark sandbox): add `--socks5-hostname localhost:1055` to curl.

## Results and errors

REST answers `{"ok": true, "data": {...}}` or `{"ok": false, "code": "...", "error": "..."}`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `EXTENSION_NOT_CONNECTED` | 503 | Remote control is off in the extension, or the bridge window is closed. |
| `RATE_LIMITED` | 429 | 120 commands/min per token (6 run_task/min). |
| `REF_UNKNOWN` | 400 | The index is not in the latest `read`. Call `read` again. |
| `NEEDS_APPROVAL` | 400 | A submit/send/delete that would ask the user. A human must do it, or allow the site. |
| `SENSITIVE_FIELD`, `HUMAN_REQUIRED` | 400 | Password, payment, one-time code, access grant: the human does it. |
| `UNSUPPORTED` | 400 | CSS selectors are not supported; use an index or x/y. |
| `TIMEOUT` | 504 | The extension did not answer in time. |

`/read` returns `{title, url, tabId, text, elements: [{index, ref, role, name, line}]}` where `line` looks like
`[12] button "Sign in"`. `/screenshot` returns PNG (`?format=png`) or `{base64, width, height, mimeType}`.
`/run_task` returns `{status, answer, done, steps, waitingForHuman, conversationId}`.
