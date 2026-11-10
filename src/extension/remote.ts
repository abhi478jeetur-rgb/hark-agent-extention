// Remote control: a connection from the worker to the Hark Bridge on this computer (ws://127.0.0.1:17345), which lets
// outside agents read and drive the active tab. Off by default; turned on in Settings → Remote.
//
// Every command goes through a layer session of its own, built like the agent's: the same write policy (the default
// permission mode and the per-site rules), the same blocked sites, no page script. A write the policy would ask about
// is declined, since no person is at the panel to approve it, and secret, payment and one-time-code fields are refused
// outright: the human types those.
import { controllerReady, addPromptRoute } from './layer';
import { createAgentSession } from './agent-session';
import type { PanelConnection, RunManager } from './run-manager';
import type { Result, ScreenshotData, Session } from '@src/browser-control';
import { DEFAULT_SETTINGS, settingsStorage } from '@src/store/settings';
import {
  DEFAULT_REMOTE,
  DEFAULT_REMOTE_STATUS,
  isLoopbackWs,
  remoteSettingsStorage,
  remoteStatusStorage,
} from '@src/store/remote';
import type { RemoteAgent, RemoteSettings, RemoteStatus } from '@src/store/remote';
import type { PanelEvent, ToolRow } from '@src/ui/protocol';
import { parseElements, RemoteError, SENSITIVE_FIELD, targetOf } from './remote-commands';
import type { RemoteElement } from './remote-commands';

const ALARM = 'hark-remote-keepalive';
const version = () => chrome.runtime.getManifest().version;

/** Plain-language errors for the codes a remote agent cannot act on alone. */
function explain(result: Result): RemoteError {
  const code = result.error?.code ?? 'INTERNAL';
  const message = result.error?.message ?? result.text;
  switch (code) {
    case 'USER_DECLINED':
    case 'CONFIRMATION_TIMEOUT':
      return new RemoteError(
        'NEEDS_APPROVAL',
        'This action was detected as a submit, send, delete or similar write, which needs a person to approve it. ' +
          'Ask the human to do it, or have them set this site to Allow (Settings > Permissions) or switch to Auto mode. ' +
          `(${message})`,
      );
    case 'USER_STEP':
    case 'NEEDS_USER':
      return new RemoteError(
        'HUMAN_REQUIRED',
        `This step is the human's (payment, password, access grant or page prompt). Ask them to do it. (${message})`,
      );
    case 'REF_UNKNOWN':
    case 'REF_NOT_PRESENTED':
    case 'STALE_DOCUMENT':
    case 'NODE_DETACHED':
      return new RemoteError(code, `${message} Call read again to get fresh element indexes.`);
    default:
      return new RemoteError(code, message);
  }
}

function ok(result: Result): Result {
  if (!result.ok) throw explain(result);
  return result;
}

interface Command {
  type: 'cmd';
  id: string;
  cmd: string;
  args?: Record<string, unknown>;
  agent?: string;
}

export class RemoteControl {
  #ws: WebSocket | null = null;
  #settings: RemoteSettings = DEFAULT_REMOTE;
  #session: Session | null = null;
  #retry = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #status: RemoteStatus = DEFAULT_REMOTE_STATUS;
  /** The elements of the latest read, per tab: what `type` checks before it types. */
  #elements = new Map<number, Map<number, RemoteElement>>();
  /** The conversation a run_task started, for stop. */
  #task: { conversationId: string | null; connection: PanelConnection } | null = null;

  constructor(private readonly runs: RunManager) {
    // Registered synchronously at worker start, so a wake-up by the alarm reconnects.
    chrome.alarms?.onAlarm.addListener(alarm => {
      if (alarm.name === ALARM) void this.#ensure();
    });
    remoteSettingsStorage.subscribe(() => {
      const next = remoteSettingsStorage.getSnapshot() ?? DEFAULT_REMOTE;
      const changed =
        next.enabled !== this.#settings.enabled ||
        next.url !== this.#settings.url ||
        next.token !== this.#settings.token;
      this.#settings = next;
      if (changed) this.#restart();
    });
    addPromptRoute({
      owns: tabId => !!this.#session?.hasTab(tabId),
      // Nobody is at the panel for a remote command: a write that asks is declined, a step for the user is cancelled.
      prompt: { confirm: async () => 'decline', ask: async () => ({ outcome: 'cancel' }) },
    });
    void remoteSettingsStorage.get().then(s => {
      this.#settings = s;
      this.#restart();
    });
  }

  // ---- connection ----

  #restart(): void {
    this.#disconnect();
    if (!this.#settings.enabled) {
      void chrome.alarms?.clear(ALARM);
      void this.#setStatus({ state: 'off', agents: [], error: undefined });
      return;
    }
    // Every 30 s (Chrome's minimum): wakes a stopped worker so it reconnects.
    void chrome.alarms?.create(ALARM, { periodInMinutes: 0.5 });
    this.#connect();
  }

  async #ensure(): Promise<void> {
    if (!this.#settings.enabled) return;
    if (!this.#ws || this.#ws.readyState === WebSocket.CLOSED) this.#connect();
  }

  #disconnect(): void {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000, 'remote turned off');
    if (this.#task) void this.#stopTask();
  }

  #connect(): void {
    const { url, token } = this.#settings;
    if (!token) {
      void this.#setStatus({ state: 'error', error: 'No bridge token. Paste the extension token from the bridge.' });
      return;
    }
    if (!isLoopbackWs(url)) {
      void this.#setStatus({ state: 'error', error: 'The bridge address must be on this computer (127.0.0.1).' });
      return;
    }
    void this.#setStatus({ state: 'connecting', error: undefined });
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (error) {
      void this.#setStatus({ state: 'error', error: String(error) });
      return this.#scheduleRetry();
    }
    this.#ws = ws;
    ws.onopen = () =>
      ws.send(JSON.stringify({ type: 'hello', token, info: { version: version(), product: 'Hark Browser Agent' } }));
    ws.onmessage = event => void this.#onMessage(ws, String(event.data));
    ws.onclose = event => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      const reason =
        event.code === 4003
          ? 'The bridge refused the token. Copy the extension token again.'
          : 'Bridge not reachable. Is it running?';
      void this.#setStatus({ state: this.#settings.enabled ? 'error' : 'off', error: reason });
      if (event.code !== 4003) this.#scheduleRetry();
    };
    ws.onerror = () => undefined;
  }

  #scheduleRetry(): void {
    if (!this.#settings.enabled || this.#retryTimer) return;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.#retry++, 5));
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#ensure();
    }, delay);
  }

  async #onMessage(ws: WebSocket, text: string): Promise<void> {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome':
        this.#retry = 0;
        await this.#setStatus({
          state: 'connected',
          error: undefined,
          since: new Date().toISOString(),
          bridgeVersion: String(msg.bridgeVersion ?? ''),
        });
        return;
      case 'ping':
        // Traffic both ways keeps the MV3 worker alive while remote control is on.
        ws.send(JSON.stringify({ type: 'pong' }));
        return;
      case 'agents':
        await this.#setStatus({ agents: (msg.agents as RemoteAgent[]) ?? [] });
        return;
      case 'cmd': {
        const command = msg as unknown as Command;
        const reply = (body: Record<string, unknown>) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'result', id: command.id, ...body }));
        };
        try {
          const data = await this.execute(command.cmd, command.args ?? {});
          reply({ ok: true, data });
          await this.#noteCommand(command, true);
        } catch (error) {
          const e = error as RemoteError;
          reply({ ok: false, code: e.code ?? 'INTERNAL', error: e.message ?? String(error) });
          await this.#noteCommand(command, false);
        }
        return;
      }
      default:
        return;
    }
  }

  async #noteCommand(command: Command, success: boolean): Promise<void> {
    await this.#setStatus({
      lastCommand: { agent: command.agent ?? '?', cmd: command.cmd, at: new Date().toISOString(), ok: success },
    });
  }

  async #setStatus(patch: Partial<RemoteStatus>): Promise<void> {
    this.#status = { ...this.#status, ...patch };
    if (this.#status.state !== 'connected') this.#status.agents = patch.agents ?? this.#status.agents;
    await remoteStatusStorage.set(this.#status).catch(() => undefined);
    const on = this.#status.state === 'connected';
    await chrome.action.setBadgeText({ text: on ? 'R' : '' }).catch(() => undefined);
    if (on) await chrome.action.setBadgeBackgroundColor({ color: '#dc2626' }).catch(() => undefined);
    await chrome.action
      .setTitle({ title: on ? 'Hark Browser Agent: REMOTE CONTROL ACTIVE' : 'Hark Browser Agent' })
      .catch(() => undefined);
  }

  // ---- the session ----

  async #sessionFor(tabId: number): Promise<Session> {
    if (!this.#session) {
      const controller = await controllerReady;
      await this.runs.permissions.ready();
      this.#session = createAgentSession(controller, {
        // Coordinate targets for agents that work from a screenshot; no page script, no devtools.
        capabilities: ['vision'],
        decideWrite: async question => {
          const settings = (await settingsStorage.get()) ?? DEFAULT_SETTINGS;
          return this.runs.permissions.decide(settings.defaultMode, question);
        },
        urlPolicy: { allow: [], deny: [], blocked: this.runs.permissions.blockedSites() },
      });
      this.runs.permissions.onBlockedChange(() => {
        void this.#session?.setUrlPolicy({ allow: [], deny: [], blocked: this.runs.permissions.blockedSites() });
      });
    }
    const session = this.#session;
    if (!session.hasTab(tabId)) {
      try {
        await session.share(tabId);
      } catch (error) {
        throw new RemoteError('TAB_NOT_ALLOWED', `This tab cannot be controlled: ${(error as Error).message}`);
      }
    }
    session.setActive(tabId);
    return session;
  }

  async #activeTab(): Promise<chrome.tabs.Tab> {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    const fallback = tab ?? (await chrome.tabs.query({ active: true, windowType: 'normal' }))[0];
    if (!fallback?.id) throw new RemoteError('NO_TAB', 'No active tab in a normal Chrome window.');
    return fallback;
  }

  // ---- commands ----

  async execute(cmd: string, args: Record<string, unknown>): Promise<unknown> {
    switch (cmd) {
      case 'status': {
        const tab = await this.#activeTab().catch(() => null);
        const settings = (await settingsStorage.get()) ?? DEFAULT_SETTINGS;
        return {
          version: version(),
          activeTab: tab ? { id: tab.id, url: tab.url, title: tab.title } : null,
          permissionMode: settings.defaultMode,
          defaultModel: settings.defaultModel,
          liteMode: !!settings.liteMode,
          runTaskAllowed: this.#settings.allowRunTask,
          taskRunning: !!this.#task,
        };
      }
      case 'tabs': {
        const tabs = await chrome.tabs.query({ windowType: 'normal' });
        return {
          tabs: tabs.map(t => ({ id: t.id, windowId: t.windowId, title: t.title, url: t.url, active: t.active })),
        };
      }
      case 'tab':
        return this.#tab(args);
      case 'navigate': {
        const tab = await this.#activeTab();
        const session = await this.#sessionFor(tab.id!);
        const call = typeof args.action === 'string' ? { action: args.action } : { url: String(args.url ?? '') };
        if (!('action' in call) && !/^https?:\/\//i.test(call.url))
          throw new RemoteError('INVALID_ARGUMENT', 'url must start with http:// or https://');
        const result = ok(await session.call('navigate', { tabId: tab.id, ...call }));
        this.#elements.delete(tab.id!);
        const fresh = await chrome.tabs.get(tab.id!);
        return { url: fresh.url, title: fresh.title, text: result.text.slice(0, 2000) };
      }
      case 'read':
        return this.#read(args);
      case 'screenshot': {
        const tab = await this.#activeTab();
        const session = await this.#sessionFor(tab.id!);
        const result = ok(
          await session.call('screenshot', {
            tabId: tab.id,
            ...(args.labels ? { labels: true } : {}),
            ...(args.fullPage ? { fullPage: true } : {}),
          }),
        );
        const data = result.data as ScreenshotData;
        return { ...data, url: tab.url, title: tab.title };
      }
      case 'click': {
        const tab = await this.#activeTab();
        const target = targetOf(args, this.#elements.get(tab.id!));
        if (!target) throw new RemoteError('INVALID_ARGUMENT', 'Give index (from read), or x and y.');
        const session = await this.#sessionFor(tab.id!);
        const result = ok(await session.call('click', { tabId: tab.id, target, observe: 'none' }));
        return { text: result.text };
      }
      case 'type':
        return this.#type(args);
      case 'scroll': {
        const tab = await this.#activeTab();
        const session = await this.#sessionFor(tab.id!);
        const target = targetOf(args, this.#elements.get(tab.id!));
        const pages = Math.max(0.1, Math.min(10, Number(args.pages) || 1));
        const call: Record<string, unknown> = { tabId: tab.id, observe: 'none', ...(target ? { target } : {}) };
        if (args.to === 'top' || args.to === 'bottom') call.to = args.to;
        else call.by = { pages: args.direction === 'up' ? -pages : pages };
        const result = ok(await session.call('scroll', call));
        return { text: result.text };
      }
      case 'key': {
        const tab = await this.#activeTab();
        if (typeof args.keys !== 'string' || !args.keys) throw new RemoteError('INVALID_ARGUMENT', 'keys is required');
        const session = await this.#sessionFor(tab.id!);
        const target = targetOf(args, this.#elements.get(tab.id!));
        const result = ok(
          await session.call('press', {
            tabId: tab.id,
            keys: args.keys,
            observe: 'none',
            ...(target ? { target } : {}),
          }),
        );
        return { text: result.text };
      }
      case 'run_task':
        return this.#runTask(args);
      case 'stop':
        return { stopped: await this.#stopTask() };
      default:
        throw new RemoteError('UNKNOWN_COMMAND', `Unknown command ${cmd}`);
    }
  }

  async #tab(args: Record<string, unknown>): Promise<unknown> {
    const action = args.action;
    if (action === 'open') {
      const url = String(args.url ?? 'about:blank');
      if (url !== 'about:blank' && !/^https?:\/\//i.test(url))
        throw new RemoteError('INVALID_ARGUMENT', 'url must start with http:// or https://');
      // Opened blank, then navigated through the session, so blocked sites stay blocked.
      const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
      if (url !== 'about:blank') {
        await new Promise(r => setTimeout(r, 300));
        const session = await this.#sessionFor(tab.id!);
        ok(await session.call('navigate', { tabId: tab.id, url }));
      }
      const fresh = await chrome.tabs.get(tab.id!);
      return { id: fresh.id, url: fresh.url, title: fresh.title };
    }
    const tabId = Number(args.tabId);
    if (!Number.isInteger(tabId)) throw new RemoteError('INVALID_ARGUMENT', 'tabId is required');
    if (action === 'switch') {
      const tab = await chrome.tabs.update(tabId, { active: true });
      if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      return { id: tabId, url: tab?.url, title: tab?.title };
    }
    if (action === 'close') {
      await chrome.tabs.remove(tabId);
      this.#elements.delete(tabId);
      return { closed: tabId };
    }
    throw new RemoteError('INVALID_ARGUMENT', 'action must be open, switch or close');
  }

  async #read(args: Record<string, unknown>): Promise<unknown> {
    const tab = await this.#activeTab();
    const session = await this.#sessionFor(tab.id!);
    const settings = (await settingsStorage.get()) ?? DEFAULT_SETTINGS;
    const lite = args.lite === undefined ? !!settings.liteMode : !!args.lite;
    const maxChars = Math.max(500, Math.min(200_000, Number(args.maxChars) || (lite ? 6000 : 20_000)));
    const outline = ok(
      await session.call('snapshot', { tabId: tab.id, mode: 'interactive', window: lite ? 'viewport' : 'page' }),
    );
    const elements = parseElements(outline.text);
    this.#elements.set(tab.id!, new Map(elements.map(e => [e.index, e])));
    const read = await session.call('read', { tabId: tab.id, format: 'text', maxChars });
    const fresh = await chrome.tabs.get(tab.id!);
    return {
      title: fresh.title,
      url: fresh.url,
      tabId: tab.id,
      lite,
      text: read.ok ? read.text : '',
      ...(args.raw ? { outline: outline.text } : {}),
      ...(read.ok ? {} : { textError: read.error?.message }),
      elements,
    };
  }

  async #type(args: Record<string, unknown>): Promise<unknown> {
    const tab = await this.#activeTab();
    if (typeof args.text !== 'string') throw new RemoteError('INVALID_ARGUMENT', 'text is required');
    const elements = this.#elements.get(tab.id!);
    const target = targetOf(args, elements);
    if (!target || 'x' in target) throw new RemoteError('INVALID_ARGUMENT', 'Give the field as index (from read).');
    // Never type into secret, payment or one-time-code fields remotely. The layer refuses secret fields as well.
    const described = elements?.get(args.index as number)?.line ?? '';
    if (SENSITIVE_FIELD.test(described)) {
      throw new RemoteError(
        'SENSITIVE_FIELD',
        `Refused: "${described}" looks like a password, payment or one-time-code field. Ask the human to type it themselves.`,
      );
    }
    const session = await this.#sessionFor(tab.id!);
    let result = await session.call('set', {
      tabId: tab.id,
      target,
      value: args.text,
      observe: 'none',
      ...(args.enter ? { submit: true } : {}),
    });
    // A widget that is not a plain field (a rich editor, a custom combobox) takes keys instead.
    if (!result.ok && result.error?.code === 'NOT_EDITABLE') {
      result = await session.call('type', {
        tabId: tab.id,
        target,
        text: args.text,
        observe: 'none',
        ...(args.enter ? { submit: true } : {}),
      });
    }
    return { text: ok(result).text };
  }

  // ---- run_task: the extension's own agent ----

  async #runTask(args: Record<string, unknown>): Promise<unknown> {
    if (!this.#settings.allowRunTask)
      throw new RemoteError('DISABLED', 'run_task is turned off in the extension (Settings > Remote).');
    if (this.#task) throw new RemoteError('BUSY', 'A task is already running. Call stop first.');
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (!prompt) throw new RemoteError('INVALID_ARGUMENT', 'prompt is required');
    const settings = (await settingsStorage.get()) ?? DEFAULT_SETTINGS;
    if (!settings.defaultModel)
      throw new RemoteError('NO_MODEL', 'No default model. Choose one in the extension: Settings > Providers.');
    const tab = await this.#activeTab();
    const timeoutMs = Math.min(3600, Math.max(10, Number(args.timeoutSec) || 600)) * 1000;

    const steps: Array<{ tool: string; status: string; args?: unknown }> = [];
    let answer = '';
    let doneArgs: unknown;
    let waitingForHuman = false;
    let conversationId: string | null = null;
    let finish!: (status: string, reason?: string) => void;
    const ended = new Promise<{ status: string; reason?: string }>(resolve => {
      finish = (status, reason) => resolve({ status, reason });
    });
    let started = false;
    const sink = (event: PanelEvent) => {
      if (event.conversationId) conversationId = event.conversationId;
      switch (event.type) {
        case 'message_end':
          if (event.entry.kind === 'assistant' && event.entry.text) answer = event.entry.text;
          return;
        case 'tool_execution_end': {
          const row: ToolRow = event.row;
          steps.push({ tool: row.tool, status: row.status, args: row.args });
          if (row.tool === 'done') doneArgs = row.args;
          return;
        }
        case 'prompt_open':
          waitingForHuman = true;
          return;
        case 'prompt_closed':
          waitingForHuman = false;
          return;
        case 'run_status':
          if (event.status === 'running') started = true;
          else if (started && ['done', 'failed', 'stopped', 'capped', 'interrupted'].includes(event.status))
            finish(event.status, event.reason);
          return;
        case 'error':
          if (!started) finish('failed', event.message);
          return;
        default:
          return;
      }
    };
    const connection: PanelConnection = { tabId: tab.id!, conversationId: null, sink };
    this.#task = { conversationId: null, connection };
    try {
      await this.runs.handle(connection, {
        type: 'send',
        tabId: tab.id!,
        conversationId: null,
        text: prompt,
        attachments: [],
        context: [],
        mode: settings.defaultMode,
        model: settings.defaultModel,
        reasoning: settings.reasoning,
      });
      this.#task.conversationId = conversationId ?? connection.conversationId;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<{ status: string; reason?: string }>(resolve => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
      });
      const end = await Promise.race([ended, timedOut]);
      clearTimeout(timer);
      return {
        status: end.status,
        reason: end.reason,
        answer: answer || undefined,
        done: doneArgs,
        steps,
        waitingForHuman,
        conversationId: conversationId ?? connection.conversationId,
        note:
          end.status === 'timeout'
            ? 'Still running in the extension. Call stop to end it, or wait and check the side panel.'
            : undefined,
      };
    } finally {
      // A finished task lets go; a timed-out one stays stoppable until stop or the next task.
      const id = conversationId ?? connection.conversationId;
      if (id && !this.runs.isRunning(id)) {
        connection.unsubscribe?.();
        this.#task = null;
      } else if (this.#task) this.#task.conversationId = id;
    }
  }

  async #stopTask(): Promise<boolean> {
    const task = this.#task;
    this.#task = null;
    const id = task?.conversationId ?? task?.connection.conversationId;
    if (!task || !id) return false;
    await this.runs.handle(task.connection, { type: 'stop', conversationId: id });
    task.connection.unsubscribe?.();
    return true;
  }
}
