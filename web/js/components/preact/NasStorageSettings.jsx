/**
 * Settings → Network storage (NAS): connect an NFS or SMB share for
 * recordings. New recordings go to the NAS while it is connected; when it is
 * not reachable they are saved on this server's disk until it is back.
 */
import { useEffect, useState } from 'preact/hooks';
import { fetchJSON } from '../../query-client.js';
import { showStatusMessage } from './ToastContainer.jsx';

const DEFAULT_VERSION = { nfs: '4.1', smb: '3.0' };
const VERSIONS = { nfs: ['4.1', '4.2', '4', '3'], smb: ['3.0', '3.1.1', '2.1', '2.0', '1.0'] };

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

const inputClass = 'w-full p-2 border border-input rounded bg-background text-foreground disabled:opacity-60 disabled:cursor-not-allowed';

export function NasStorageSettings({ canModify }) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({ type: 'nfs', server: '', share: '', username: '', password: '', version: '4.1' });
  const [busy, setBusy] = useState('');
  const [testResult, setTestResult] = useState(null);

  const applySaved = (data, resetForm) => {
    setSaved(data);
    if (resetForm) {
      setForm({
        type: data.type || 'nfs',
        server: data.server || '',
        share: data.share || '',
        username: data.username || '',
        password: '',
        version: data.version || DEFAULT_VERSION[data.type || 'nfs'],
      });
    }
  };

  // Settings once, then the status every 15 s (the NAS can come and go)
  useEffect(() => {
    let cancelled = false;
    const load = async (first) => {
      try {
        const data = await fetchJSON('/api/storage/nas', { timeout: 10000 });
        if (!cancelled) {
          applySaved(data, first);
          setLoaded(true);
        }
      } catch (error) {
        if (!cancelled && first) {
          setLoaded(true);
          setSaved(null);
        }
      }
    };
    load(true);
    const timer = setInterval(() => load(false), 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const update = (field, value) => {
    setTestResult(null);
    setForm((previous) => {
      const next = { ...previous, [field]: value };
      if (field === 'type') next.version = DEFAULT_VERSION[value];
      return next;
    });
  };

  const body = () => JSON.stringify({
    type: form.type,
    server: form.server.trim(),
    share: form.share.trim(),
    username: form.type === 'smb' ? form.username.trim() : '',
    password: form.type === 'smb' ? form.password : '',
    version: form.version,
  });

  const missing = !form.server.trim() || !form.share.trim();

  const testConnection = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      const result = await fetchJSON('/api/storage/nas/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(), timeout: 60000,
      });
      setTestResult(result);
    } catch (error) {
      setTestResult({ ok: false, message: error.message || 'Test failed' });
    } finally {
      setBusy('');
    }
  };

  const connect = async () => {
    setBusy('connect');
    setTestResult(null);
    try {
      const result = await fetchJSON('/api/storage/nas/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(), timeout: 90000,
      });
      applySaved(result, true);
      showStatusMessage(result.warning || 'NAS connected. New recordings are saved on the NAS.', result.warning ? 'warning' : 'success', 6000);
    } catch (error) {
      setTestResult({ ok: false, message: error.message || 'Could not connect' });
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Disconnect the NAS? New recordings will be saved on this server\'s disk. Recordings already on the NAS stay there, but cannot be played while it is disconnected.')) return;
    setBusy('disconnect');
    try {
      const result = await fetchJSON('/api/storage/nas/disconnect', { method: 'POST', timeout: 30000 });
      applySaved(result, false);
      showStatusMessage('NAS disconnected. New recordings are saved on this server\'s disk.');
    } catch (error) {
      showStatusMessage(error.message || 'Could not disconnect', 'error', 6000);
    } finally {
      setBusy('');
    }
  };

  if (!loaded) return null;

  const status = saved?.status || { state: 'disabled' };
  const enabled = Boolean(saved?.enabled);
  const space = status.total_bytes ? `${formatBytes(status.free_bytes)} free of ${formatBytes(status.total_bytes)}` : '';
  const statusView = !enabled
    ? { tone: 'muted', title: 'Not connected', text: 'Recordings are saved on this server\'s disk.' }
    : status.state === 'connected'
      ? { tone: 'ok', title: `Connected to ${saved.type === 'smb' ? 'SMB' : 'NFS'} //${saved.server}`, text: `New recordings are saved on the NAS.${space ? ` ${space}.` : ''}` }
      : { tone: 'bad', title: 'NAS not reachable', text: `Recordings are saved on this server's disk until the NAS is back.${status.error ? ` (${status.error})` : ''}` };
  const toneStyle = {
    ok: { borderColor: 'hsl(142 70% 40% / 0.45)', background: 'hsl(142 70% 40% / 0.08)' },
    bad: { borderColor: 'hsl(0 75% 50% / 0.45)', background: 'hsl(0 75% 50% / 0.07)' },
    muted: { borderColor: 'hsl(var(--border))', background: 'hsl(var(--muted) / 0.35)' },
  }[statusView.tone];
  const dotColor = { ok: 'hsl(142 70% 40%)', bad: 'hsl(0 75% 50%)', muted: 'hsl(var(--muted-foreground))' }[statusView.tone];
  const changed = enabled && (form.type !== saved.type || form.server.trim() !== saved.server || form.share.trim() !== saved.share
    || form.username.trim() !== (saved.username || '') || form.password !== '' || form.version !== saved.version);

  return (
    <div class="settings-group bg-card text-card-foreground rounded-lg shadow p-4" data-testid="nas-settings">
      <h3 class="text-lg font-semibold mb-4 pb-2 border-b border-border">Network Storage (NAS)</h3>

      <div data-testid="nas-status" data-state={enabled ? status.state : 'disabled'}
        style={{ border: '1px solid', ...toneStyle, borderRadius: '0.5rem', padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <span aria-hidden="true" style={{ width: '0.6rem', height: '0.6rem', borderRadius: '999px', background: dotColor, marginTop: '0.4rem', flex: '0 0 auto' }} />
        <div>
          <div class="font-medium">{statusView.title}</div>
          <div class="text-sm text-muted-foreground">{statusView.text}</div>
        </div>
      </div>

      <div class="setting grid grid-cols-1 md:grid-cols-3 gap-4 items-center mb-4">
        <span class="font-medium">Type</span>
        <div class="col-span-2" role="radiogroup" aria-label="NAS type" style={{ display: 'flex', gap: '1.25rem' }}>
          {[['nfs', 'NFS (Linux, Synology, QNAP)'], ['smb', 'SMB / Windows share']].map(([value, label]) => (
            <label key={value} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
              <input type="radio" name="nas-type" value={value} checked={form.type === value} disabled={!canModify || Boolean(busy)}
                onChange={() => update('type', value)} style={{ accentColor: 'hsl(var(--primary))' }} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div class="setting grid grid-cols-1 md:grid-cols-3 gap-4 items-center mb-4">
        <label for="nas-server" class="font-medium">NAS address</label>
        <div class="col-span-2">
          <input id="nas-server" data-testid="nas-server" type="text" class={inputClass} placeholder="e.g. 192.168.1.50"
            value={form.server} disabled={!canModify || Boolean(busy)} autoComplete="off" spellCheck={false}
            onInput={(event) => update('server', event.currentTarget.value)} />
        </div>
      </div>

      <div class="setting grid grid-cols-1 md:grid-cols-3 gap-4 items-center mb-4">
        <label for="nas-share" class="font-medium">Shared folder</label>
        <div class="col-span-2">
          <input id="nas-share" data-testid="nas-share" type="text" class={inputClass}
            placeholder={form.type === 'nfs' ? 'e.g. /volume1/recordings' : 'e.g. recordings'}
            value={form.share} disabled={!canModify || Boolean(busy)} autoComplete="off" spellCheck={false}
            onInput={(event) => update('share', event.currentTarget.value)} />
          <span class="hint text-sm text-muted-foreground block mt-1">
            {form.type === 'nfs'
              ? 'The NFS export path. On the NAS, allow this server\'s IP address with read/write access.'
              : 'The share name as shown on the NAS (a subfolder can follow, e.g. recordings/nvr1).'}
          </span>
        </div>
      </div>

      {form.type === 'smb' && (
        <>
          <div class="setting grid grid-cols-1 md:grid-cols-3 gap-4 items-center mb-4">
            <label for="nas-username" class="font-medium">User name</label>
            <div class="col-span-2">
              <input id="nas-username" data-testid="nas-username" type="text" class={inputClass} placeholder="Leave empty for guest access"
                value={form.username} disabled={!canModify || Boolean(busy)} autoComplete="off" spellCheck={false}
                onInput={(event) => update('username', event.currentTarget.value)} />
            </div>
          </div>
          <div class="setting grid grid-cols-1 md:grid-cols-3 gap-4 items-center mb-4">
            <label for="nas-password" class="font-medium">Password</label>
            <div class="col-span-2">
              <input id="nas-password" data-testid="nas-password" type="password" class={inputClass}
                placeholder={saved?.has_password ? 'Saved (leave empty to keep it)' : ''}
                value={form.password} disabled={!canModify || Boolean(busy)} autoComplete="new-password"
                onInput={(event) => update('password', event.currentTarget.value)} />
            </div>
          </div>
        </>
      )}

      <div class="setting grid grid-cols-1 md:grid-cols-3 gap-4 items-center mb-4">
        <label for="nas-version" class="font-medium">{form.type === 'nfs' ? 'NFS version' : 'SMB version'}</label>
        <div class="col-span-2">
          <select id="nas-version" class="p-2 border border-input rounded bg-background text-foreground disabled:opacity-60"
            value={form.version} disabled={!canModify || Boolean(busy)} onChange={(event) => update('version', event.currentTarget.value)}>
            {VERSIONS[form.type].map((version) => <option key={version} value={version}>{version}</option>)}
          </select>
          <span class="hint text-sm text-muted-foreground" style={{ marginLeft: '0.5rem' }}>Keep the default unless the NAS needs another.</span>
        </div>
      </div>

      {testResult && (
        <div data-testid="nas-test-result" role="status"
          style={{ border: '1px solid', borderRadius: '0.5rem', padding: '0.6rem 0.9rem', marginBottom: '1rem',
            ...(testResult.ok ? { borderColor: 'hsl(142 70% 40% / 0.45)', background: 'hsl(142 70% 40% / 0.08)' } : { borderColor: 'hsl(0 75% 50% / 0.45)', background: 'hsl(0 75% 50% / 0.07)' }) }}>
          <span class="font-medium">{testResult.ok ? 'Test passed: ' : 'Test failed: '}</span>
          <span class="text-sm">
            {testResult.message}
            {testResult.ok && testResult.total_bytes ? `. ${formatBytes(testResult.free_bytes)} free of ${formatBytes(testResult.total_bytes)}.` : ''}
          </span>
        </div>
      )}

      {canModify && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button type="button" class="btn-secondary" data-testid="nas-test" disabled={missing || Boolean(busy)} onClick={testConnection}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {enabled && (
            <button type="button" class="btn-secondary" data-testid="nas-disconnect" disabled={Boolean(busy)} onClick={disconnect}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
          {(!enabled || changed) && (
            <button type="button" class="btn-primary" data-testid="nas-connect" disabled={missing || Boolean(busy)} onClick={connect}>
              {busy === 'connect' ? 'Connecting…' : (enabled ? 'Save and reconnect' : 'Connect')}
            </button>
          )}
        </div>
      )}
      <p class="text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        Only new recordings go to the NAS; recordings already on this server stay here and can still be played.
        Retention and "delete oldest when full" apply to the NAS while it is connected.
      </p>
    </div>
  );
}
