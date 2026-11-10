# Hark Browser Agent

An AI browser agent for Chrome (MV3) that you can also **control remotely** from other AI agents – Hark, Claude
Desktop / Claude Code, Codex, Cursor, n8n or your own scripts – over [Tailscale](https://tailscale.com).

Hark Browser Agent is a fork of [Nanobrowser](https://github.com/nanobrowser/nanobrowser) (Apache-2.0). Lite mode
and the indexed element list are inspired by [page-agent](https://github.com/alibaba/page-agent) (MIT). See
[NOTICE](NOTICE) and [LICENSE](LICENSE). The original project README is in
[docs/NANOBROWSER_README.md](docs/NANOBROWSER_README.md).

## What it does

- **Side-panel agent** (from Nanobrowser): one agent that reads and acts on your tabs with trusted input through
  `chrome.debugger`, with Ask/Auto permission modes, per-site rules, and hand-over for payments and passwords.
- **Any model**: OpenAI-compatible (custom base URL + key + model name) for any self-hosted or open-source model,
  plus presets: Ollama, LM Studio, OpenRouter, Groq, Together AI, DeepSeek, Mistral, xAI, Google Gemini, OpenAI,
  Anthropic, AWS Bedrock.
- **Test connection** on every provider card: `OK · 16 ms · tool calling works`, or the exact error (key refused,
  CORS/origin refused with the fix, model not found, no tool calling).
- **Lite mode** (Settings → General): shorter page reads (interactive elements near the viewport, shorter text)
  for small/local models.
- **Remote control** (Settings → Remote, off by default) through the **Hark Bridge** (`bridge/`):
  HTTP API, **MCP server** (Streamable HTTP at `/mcp` + stdio proxy), **OpenAPI** at `/openapi.json`, named
  revocable tokens per agent, rate limiting and logs. A red **R** badge and a side-panel banner with a big
  **Disconnect** show when it is active.

```
 agent (Hark / Claude / Codex / Cursor / n8n / script)
        │  HTTP or MCP, Bearer token, over Tailscale
        ▼
 Hark Bridge on the laptop  ── http://0.0.0.0:17346
        │  WebSocket, extension token, 127.0.0.1 only
        ▼
 Chrome + Hark Browser Agent extension (Settings → Remote)
```

## Quick start

1. Build or download the extension and **Load unpacked** in `chrome://extensions` → [docs/SETUP.md](docs/SETUP.md).
2. Install Node.js 18+, unzip the bridge, run `start-bridge.bat`, paste the printed *extension token* into
   Settings → Remote and switch it on.
3. Connect an agent with the *agent token* → [docs/AGENTS.md](docs/AGENTS.md) (Claude Desktop, Claude Code, Codex,
   Cursor, n8n, curl) or `client/hark_remote.py`.

## Repository layout

| Path | What |
| --- | --- |
| `entrypoints/`, `src/` | The extension (WXT + React + TypeScript). Remote control: `src/extension/remote.ts`, `src/extension/remote-commands.ts`, `src/store/remote.ts`, `src/options/RemoteSection.tsx`, `src/side-panel/RemoteBanner.tsx` |
| `bridge/` | Hark Bridge (Node 18+, no dependencies): `bridge.js`, `lib/` (WebSocket, MCP, OpenAPI, tools), `start-bridge.bat`, tests |
| `client/` | `hark_remote.py` (Python stdlib client with SOCKS5), `tailscale_up.sh` (userspace Tailscale for sandboxes) |
| `docs/` | `SETUP.md`, `AGENTS.md` |

## Build

Node 24 and pnpm 10.34.7 (via corepack):

```bash
corepack enable
pnpm install
pnpm build        # dist/  (load this folder unpacked)
pnpm zip          # dist-zip/hark-browser-agent-<version>.zip
pnpm test         # extension unit tests (vitest)
cd bridge && npm test                     # bridge + Python client tests (node:test)
xvfb-run -a node bridge/test/e2e-chromium.mjs /usr/bin/chromium   # end-to-end with a real Chromium
```

## Security

Remote control is off by default, requires two separate tokens, follows your permission mode and per-site rules,
refuses writes that would need your approval, and never types into password, payment or one-time-code fields.
Only expose the bridge over Tailscale. Details: [docs/SETUP.md](docs/SETUP.md#6-security-notes).

## License

Apache-2.0 (see [LICENSE](LICENSE)); third-party notices in [NOTICE](NOTICE).
