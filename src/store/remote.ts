// Remote control (Hark Bridge) settings and live status, in chrome.storage so the worker, Settings and the side panel
// share them. The settings are off by default; the status is written only by the worker.
import { createStorage } from './storage';

export interface RemoteSettings {
  /** Remote control on: the worker keeps a connection to the bridge. Off by default. */
  enabled: boolean;
  /** The bridge's local socket. Only loopback addresses are accepted by the worker. */
  url: string;
  /** The bridge's extension token (from bridge/config.json, printed on its first run). */
  token: string;
  /** Allow `run_task`: outside agents may start the extension's own agent. */
  allowRunTask: boolean;
}

export const DEFAULT_REMOTE: RemoteSettings = {
  enabled: false,
  url: 'ws://127.0.0.1:17345',
  token: '',
  allowRunTask: true,
};

export const remoteSettingsStorage = createStorage<RemoteSettings>('hark.remote.settings', DEFAULT_REMOTE, {
  liveUpdate: true,
  merge: stored => ({ ...DEFAULT_REMOTE, ...(stored && typeof stored === 'object' ? (stored as object) : {}) }),
});

export interface RemoteAgent {
  name: string;
  ip?: string;
  via?: string;
  lastSeen: string;
  lastCommand?: string;
}

export interface RemoteStatus {
  state: 'off' | 'connecting' | 'connected' | 'error';
  error?: string;
  since?: string;
  bridgeVersion?: string;
  /** Agents the bridge reported, newest first. */
  agents: RemoteAgent[];
  /** The latest command, for the banner. */
  lastCommand?: { agent: string; cmd: string; at: string; ok?: boolean };
}

export const DEFAULT_REMOTE_STATUS: RemoteStatus = { state: 'off', agents: [] };

export const remoteStatusStorage = createStorage<RemoteStatus>('hark.remote.status', DEFAULT_REMOTE_STATUS, {
  area: 'local',
  liveUpdate: true,
  merge: stored => ({
    ...DEFAULT_REMOTE_STATUS,
    ...(stored && typeof stored === 'object' ? (stored as object) : {}),
  }),
});

/** Only loopback bridge addresses: the extension never dials out to another machine. */
export function isLoopbackWs(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.protocol === 'ws:' || u.protocol === 'wss:') && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}
