// The side panel's banner while remote control (Hark Bridge) is connected: who is driving and a big Disconnect.
// It reads the status the worker writes and turns remote control off through the shared setting.
import { DEFAULT_REMOTE_STATUS, remoteSettingsStorage, remoteStatusStorage } from '@src/store/remote';
import { useStorage } from '@src/ui/hooks';

export function RemoteBanner() {
  const status = useStorage(remoteStatusStorage, DEFAULT_REMOTE_STATUS);
  if (status.state !== 'connected') return null;
  const last = status.lastCommand;
  const agent = last?.agent ?? status.agents[0]?.name;
  return (
    <div
      role="status"
      data-testid="remote-banner"
      className="flex items-center gap-2 border-b-2 border-red-600 bg-red-600/10 px-3 py-2 text-sm">
      <span aria-hidden className="inline-flex size-2.5 shrink-0 animate-pulse rounded-full bg-red-600" />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">Remote control active</span>
        {agent ? (
          <span className="block truncate text-xs opacity-80">
            {agent}
            {last ? ` · last: ${last.cmd}` : ''}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 font-semibold text-white hover:bg-red-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600"
        onClick={() => void remoteSettingsStorage.set(s => ({ ...s, enabled: false }))}>
        Disconnect
      </button>
    </div>
  );
}
