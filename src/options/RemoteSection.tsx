// Settings → Remote: remote control through the Hark Bridge, a small program on this computer that lets outside AI
// agents (Hark, Claude, Codex, Cursor, scripts) read and drive the browser. Off by default. The worker owns the
// connection; this page writes the settings and shows the status the worker writes.
import { useEffect, useState } from 'react';
import {
  DEFAULT_REMOTE,
  DEFAULT_REMOTE_STATUS,
  isLoopbackWs,
  remoteSettingsStorage,
  remoteStatusStorage,
} from '@src/store/remote';
import { Button, Input, Notice, Switch } from '@src/ui/components';
import { useStorage } from '@src/ui/hooks';
import { EyeIcon, EyeOffIcon } from '@src/ui/icons';
import { SettingsCard, SettingsRow } from './SettingsCard';

function ago(iso?: string): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return new Date(iso).toLocaleString();
}

export function RemoteSection() {
  const settings = useStorage(remoteSettingsStorage, DEFAULT_REMOTE);
  const status = useStorage(remoteStatusStorage, DEFAULT_REMOTE_STATUS);
  const [token, setToken] = useState(settings.token);
  const [url, setUrl] = useState(settings.url);
  const [show, setShow] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => setToken(settings.token), [settings.token]);
  useEffect(() => setUrl(settings.url), [settings.url]);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const dirty = token !== settings.token || url !== settings.url;
  const urlOk = isLoopbackWs(url);
  const connected = status.state === 'connected';

  return (
    <section className="flex flex-col gap-6">
      <h2 className="sr-only">Remote</h2>
      {connected ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-xl border-2 border-red-600 bg-red-600/10 px-5 py-4">
          <span className="inline-flex size-3 animate-pulse rounded-full bg-red-600" aria-hidden />
          <span className="flex-1 font-medium">
            Remote control is active. Outside agents can read and use this browser.
          </span>
          <Button
            variant="primary"
            className="border border-red-700 bg-red-600 hover:bg-red-700"
            onClick={() => void remoteSettingsStorage.set(s => ({ ...s, enabled: false }))}>
            Disconnect
          </Button>
        </div>
      ) : null}
      <SettingsCard
        title="Remote control"
        description="Let AI agents on other devices (Hark, Claude, Codex, Cursor, n8n, your scripts) control this browser through the Hark Bridge, a small program you run on this computer and reach over Tailscale. Off by default.">
        <div className="flex flex-col gap-5">
          <SettingsRow
            label="Allow remote control"
            description="Connects to the bridge on this computer. A red R on the toolbar icon shows when it is active.">
            <Switch
              aria-label="Allow remote control"
              checked={settings.enabled}
              onChange={on => void remoteSettingsStorage.set(s => ({ ...s, enabled: on }))}
            />
          </SettingsRow>
          <SettingsRow
            label="Bridge token"
            description="The EXTENSION token the bridge printed on its first run (or: node bridge.js token rotate-extension).">
            <div className="flex items-center gap-2">
              <Input
                aria-label="Bridge token"
                type={show ? 'text' : 'password'}
                className="w-72 font-mono"
                value={token}
                placeholder="paste the extension token"
                autoComplete="off"
                onChange={e => setToken(e.target.value.trim())}
              />
              <button
                type="button"
                aria-label={show ? 'Hide token' : 'Show token'}
                className="rounded-md p-1.5 text-nb-muted hover:bg-nb-surface"
                onClick={() => setShow(s => !s)}>
                {show ? <EyeOffIcon size={16} /> : <EyeIcon size={16} />}
              </button>
            </div>
          </SettingsRow>
          <SettingsRow
            label="Bridge address"
            description="The bridge's local socket. Only addresses on this computer are allowed.">
            <Input
              aria-label="Bridge address"
              className="w-72 font-mono"
              value={url}
              onChange={e => setUrl(e.target.value.trim())}
            />
          </SettingsRow>
          {!urlOk ? (
            <Notice tone="error">The address must be ws://127.0.0.1:&lt;port&gt; (this computer).</Notice>
          ) : null}
          <div className="flex justify-end">
            <Button
              variant="primary"
              disabled={!dirty || !urlOk}
              onClick={() => void remoteSettingsStorage.set(s => ({ ...s, token, url }))}>
              Save
            </Button>
          </div>
          <SettingsRow
            label="Allow run_task"
            description="Outside agents may start this extension's own agent with a task, using your default model and permission mode.">
            <Switch
              aria-label="Allow run_task"
              checked={settings.allowRunTask}
              onChange={on => void remoteSettingsStorage.set(s => ({ ...s, allowRunTask: on }))}
            />
          </SettingsRow>
        </div>
      </SettingsCard>
      <SettingsCard title="Status">
        <div className="flex flex-col gap-3 text-[15px]">
          <div className="flex items-center gap-2">
            <span
              aria-hidden
              className={`inline-flex size-2.5 rounded-full ${connected ? 'bg-red-600' : status.state === 'connecting' ? 'bg-amber-500' : status.state === 'error' ? 'bg-nb-muted' : 'bg-nb-border'}`}
            />
            <span>
              {connected
                ? `Connected to the bridge${status.bridgeVersion ? ` ${status.bridgeVersion}` : ''} ${ago(status.since)}`
                : status.state === 'connecting'
                  ? 'Connecting…'
                  : status.state === 'error'
                    ? 'Not connected'
                    : 'Off'}
            </span>
          </div>
          {status.error && status.state !== 'connected' && settings.enabled ? (
            <Notice tone="warn">{status.error}</Notice>
          ) : null}
          <div>
            <div className="mb-2 font-medium">Agents using the bridge</div>
            {status.agents.length ? (
              <ul className="divide-y divide-nb-border rounded-lg border border-nb-border">
                {status.agents.map(a => (
                  <li key={a.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                    <span className="font-mono font-medium">{a.name}</span>
                    <span className="text-nb-muted">{a.via?.toUpperCase()}</span>
                    {a.ip ? <span className="text-nb-muted">{a.ip}</span> : null}
                    <span className="flex-1" />
                    <span className="text-nb-muted">
                      {a.lastCommand ? `${a.lastCommand} · ` : ''}
                      {ago(a.lastSeen)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-nb-muted">No agent has sent a command yet.</p>
            )}
            <p className="mt-2 text-sm text-nb-muted">
              Each agent has its own named token in the bridge&apos;s config.json. Revoke one with: node bridge.js token
              revoke &lt;name&gt;
            </p>
          </div>
        </div>
      </SettingsCard>
      <SettingsCard title="Safety">
        <ul className="list-disc space-y-1.5 pl-5 text-[15px] text-nb-muted">
          <li>
            Remote commands follow your permission mode and per-site rules. A write that would ask you is refused.
          </li>
          <li>Remote agents can never type into password, payment or one-time-code fields; you do those yourself.</li>
          <li>Blocked sites stay blocked. Every command is logged in the bridge&apos;s logs folder.</li>
          <li>The bridge only accepts agents with a valid token. Reach it over Tailscale, never the open internet.</li>
        </ul>
      </SettingsCard>
    </section>
  );
}
