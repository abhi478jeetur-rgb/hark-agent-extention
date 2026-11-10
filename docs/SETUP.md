# Setup: Hark Browser Agent + Hark Bridge + Tailscale

This guide gets an outside agent (Hark in its Linux sandbox, or Claude, Codex, Cursor, n8n, a script) controlling
Chrome on your Windows laptop.

```
 Hark sandbox / any agent                    Your Windows laptop
 ───────────────────────                     ─────────────────────────────────────────────
 hark_remote.py / MCP client  ──Tailscale──▶  Hark Bridge  http://<tailscale-ip>:17346  (agent tokens)
                                                  │
                                                  ▼  ws://127.0.0.1:17345 (extension token, this PC only)
                                              Chrome + Hark Browser Agent extension
```

## 1. Install the extension (Chrome, "Load unpacked")

1. Get `hark-browser-agent-<version>-chrome.zip` (from `dist-zip/` after `pnpm zip`, or from the release).
2. Unzip it to a folder you will keep, for example `C:\Hark\extension`.
3. Open `chrome://extensions`, turn on **Developer mode** (top right).
4. Click **Load unpacked** and pick the unzipped folder (the one that contains `manifest.json`).
5. Pin the extension. Open its side panel with the toolbar icon or `Alt+Shift+N`.
6. Settings → **Providers**: add a model.
   - Any OpenAI-compatible server: choose **OpenAI-compatible**, enter the base URL (for example
     `http://localhost:8000/v1`), the API key if it needs one, then add the model name.
   - Presets: OpenAI, Anthropic, Google Gemini, OpenRouter, Groq, Together AI, DeepSeek, Mistral, xAI, AWS Bedrock,
     Ollama (`http://localhost:11434`), LM Studio (`http://localhost:1234`).
   - Press **Test connection** on the card. You get `OK · N ms · tool calling works`, or the exact error
     (key refused, CORS / origin refused with the fix, model not found, no tool calling).
   - Ollama needs `OLLAMA_ORIGINS=chrome-extension://*` so the extension may call it; the card shows the exact fix.
7. Optional: Settings → General → **Lite mode** for small/local models (shorter page reads).

## 2. Install Node.js

Install the **LTS** version from <https://nodejs.org> (Node 18 or newer). Accept the defaults.
Check in a new Command Prompt: `node -v`.

## 3. Run the bridge

1. Unzip `hark-bridge-<version>.zip` to e.g. `C:\Hark\bridge`.
2. Double-click **`start-bridge.bat`**.
3. On the first run it creates `config.json` and prints two tokens **once**:
   - **EXTENSION TOKEN** – paste it in the extension: Settings → **Remote** → Bridge token → Save, then turn on
     **Allow remote control**. The toolbar icon shows a red **R** and the side panel shows a red banner.
   - **AGENT TOKEN "default"** – give it to the agent (save it in a file such as `token.txt`).
4. Keep the window open while you want remote control. Close it (or press **Disconnect** in the side panel) to stop.

More agent tokens, one per agent, so you can revoke them separately:

```bat
node bridge.js token add claude-desktop
node bridge.js token add hark
node bridge.js token list
node bridge.js token revoke claude-desktop     :: takes effect within ~2 s, no restart
node bridge.js token rotate-extension          :: new extension token (paste it in Settings > Remote)
```

Tokens live in `bridge\config.json` (`tokens[]`, set `"revoked": true` to revoke by hand). Every command is logged
in `bridge\logs\bridge-YYYY-MM-DD.log` (typed text is logged as its length only).

## 4. Windows firewall (port 17346)

The first start may show a Windows Defender Firewall prompt for Node.js: allow it on **Private** networks.
To allow only Tailscale, run this once in an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "Hark Bridge (Tailscale only)" -Direction Inbound -Protocol TCP `
  -LocalPort 17346 -RemoteAddress 100.64.0.0/10 -Action Allow
```

Port 17345 (extension socket) listens on 127.0.0.1 only and never needs a firewall rule.

## 5. Tailscale

Both devices must be in the **same tailnet**.

**Laptop**: Tailscale is installed; sign in. Find its IP: click the tray icon → your device, or run
`tailscale ip -4` (looks like `100.x.y.z`).

**Hark sandbox (Linux, no root/TUN needed)**:

1. Create an auth key at <https://login.tailscale.com/admin/settings/keys>. Recommended: **Reusable** and
   **Ephemeral** (the sandbox node disappears when it goes offline). Optionally tag it.
2. In the sandbox:

   ```bash
   export TS_AUTHKEY=tskey-auth-xxxxx      # never commit or log it
   ./client/tailscale_up.sh
   ```

   It downloads the static Tailscale binaries and runs
   `tailscaled --tun=userspace-networking --socks5-server=localhost:1055`, then `tailscale up`.
3. Talk to the laptop through the SOCKS5 proxy:

   ```bash
   echo "<agent token>" > ~/.hark_token && chmod 600 ~/.hark_token
   python3 client/hark_remote.py --host 100.x.y.z --token-file ~/.hark_token --socks5 localhost:1055 status
   python3 client/hark_remote.py --host 100.x.y.z --token-file ~/.hark_token --socks5 localhost:1055 read
   python3 client/hark_remote.py ... screenshot page.png
   python3 client/hark_remote.py ... click 12
   python3 client/hark_remote.py ... type 7 "hello" --enter
   python3 client/hark_remote.py ... navigate https://example.com
   python3 client/hark_remote.py ... run "Summarise this page in 3 bullets"
   ```

   On a machine with normal Tailscale (Mac, Windows, Linux with TUN) leave out `--socks5`.

Optional ACL (Tailscale admin → Access controls) so only the sandbox may reach the bridge port:

```json
{ "action": "accept", "src": ["tag:hark"], "dst": ["<laptop-name>:17346"] }
```

## 6. Security notes

- Remote control is **off by default** and needs both the extension token (on the laptop) and an agent token.
- Every bridge endpoint, including `/mcp` and `/openapi.json`, requires `Authorization: Bearer <agent token>`.
- Reach the bridge only over Tailscale. Do not port-forward 17346 on your router.
- Remote commands follow your permission mode and per-site rules (Settings → Permissions). A submit, send or delete
  that would ask you is **refused** for remote agents (no one is at the panel to approve). Payments, access grants
  and password / card / one-time-code fields are refused in every mode: you do those yourself.
- Blocked sites stay blocked. The extension only connects to a bridge on `127.0.0.1`.
- `run_task` (start the extension's own agent) can be switched off in Settings → Remote, or with
  `"allowRunTask": false` in `config.json`.
- Rate limit: 120 commands/min per agent token, 6 `run_task`/min (change in `config.json`).
- Revoke an agent: `node bridge.js token revoke <name>`. Stop everything: press **Disconnect** or close the bridge.
- `config.json` holds secrets: do not share or commit it (it is in `.gitignore`).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `503 EXTENSION_NOT_CONNECTED` | Settings → Remote: token pasted, switch on, bridge window open. |
| Remote tab says "refused the token" | Paste the EXTENSION token (not an agent token), or `token rotate-extension`. |
| `401` | Wrong/revoked agent token. `node bridge.js token list`. |
| Client times out | Laptop asleep, Tailscale off, firewall rule missing, or wrong IP. `tailscale ping <laptop>`. |
| `NEEDS_APPROVAL` | The action is a write that asks you. Do it yourself, or set the site to Allow / use Auto mode. |
| `SENSITIVE_FIELD` / `HUMAN_REQUIRED` | Password, payment or code: type it yourself on the laptop. |
| `REF_UNKNOWN` | Call `read` again; indexes change when the page changes. |
