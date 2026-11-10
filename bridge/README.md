# Hark Bridge

Connects outside AI agents to the **Hark Browser Agent** Chrome extension. Node.js 18+, no dependencies.

- Windows: double-click `start-bridge.bat`. Others: `./start-bridge.sh` or `node bridge.js`.
- First run creates `config.json` and prints the **extension token** (paste in the extension: Settings → Remote)
  and the first **agent token** (`default`), once.
- `ws://127.0.0.1:17345` – the extension connects here (this computer only).
- `http://0.0.0.0:17346` – agents connect here over Tailscale, with `Authorization: Bearer <agent token>`:
  REST tools, MCP at `/mcp`, OpenAPI at `/openapi.json`.

```
node bridge.js token list
node bridge.js token add <name>          # one token per agent; shown once
node bridge.js token revoke <name>       # takes effect within ~2 s
node bridge.js token unrevoke <name>
node bridge.js token remove <name>
node bridge.js token rotate-extension
node bridge.js --mcp-stdio --remote http://<tailscale-ip>:17346 --token <token>   # MCP stdio proxy
```

`config.json` settings: `httpHost`, `httpPort`, `wsPort`, `rateLimitPerMinute` (120), `runTaskPerMinute` (6),
`runTaskTimeoutSec` (600), `commandTimeoutSec` (60), `allowRunTask` (true), `logDir` (`logs`), `tokens[]`
(`name`, `token`, `revoked`).

Logs: `logs/bridge-YYYY-MM-DD.log`, one JSON line per command (agent, IP, tool, arguments with typed text reduced to
its length, result code, duration).

See `../docs/SETUP.md` and `../docs/AGENTS.md`.
