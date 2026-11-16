/**
 * Settings → Network storage (NAS): connect an NFS or SMB share and choose,
 * as in Nx Witness, how it is used:
 *   - Recording: new recordings go straight to the NAS (needs a fast network).
 *   - Backup: cameras record to this server's disk; finished recordings are
 *     copied to the NAS in the background (real time or on a schedule, at a
 *     limited speed), and stay playable from the NAS after the local copy goes.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';
import { fetchJSON } from '../../query-client.js';
import { showStatusMessage } from './ToastContainer.jsx';

const DEFAULT_VERSION = { nfs: '4.1', smb: '3.0' };
const VERSIONS = { nfs: ['4.1', '4.2', '4', '3'], smb: ['3.0', '3.1.1', '2.1', '2.0', '1.0'] };
const DEFAULT_BACKUP = {
  when: 'realtime',
  schedule_start_hour: 0,
  schedule_end_hour: 6,
  bwlimit_mbps: 0,
  events_only: false,
  include_existing: false,
  delete_local: false,
  reserve_gb: 50,
  keep_days: 0,
  cameras: [],
};
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function formatTime(seconds) {
  if (!seconds) return '';
  const date = new Date(seconds * 1000);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const hourLabel = (hour) => `${String(hour).padStart(2, '0')}:00`;

function backupFrom(data) {
  const backup = data?.backup || {};
  return {
    ...DEFAULT_BACKUP,
    ...Object.fromEntries(Object.keys(DEFAULT_BACKUP).filter((key) => backup[key] !== undefined).map((key) => [key, backup[key]])),
    cameras: Array.isArray(backup.cameras) ? backup.cameras : [],
  };
}

function sameBackup(a, b) {
  return Object.keys(DEFAULT_BACKUP).every((key) => (key === 'cameras'
    ? [...a.cameras].sort().join('\n') === [...b.cameras].sort().join('\n')
    : String(a[key]) === String(b[key])));
}

const inputClass = 'w-full p-2 border border-input rounded bg-background text-foreground disabled:opacity-60 disabled:cursor-not-allowed';
const selectClass = 'p-2 border border-input rounded bg-background text-foreground disabled:opacity-60';
const rowClass = 'setting grid grid-cols-1 md:grid-cols-3 gap-4 items-start mb-4';

function Radio({ name, value, checked, disabled, onChange, label, hint, testId }) {
  return (
    <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', cursor: disabled ? 'default' : 'pointer' }}>
      <input type="radio" name={name} value={value} checked={checked} disabled={disabled} data-testid={testId}
        onChange={onChange} style={{ accentColor: 'hsl(var(--primary))', marginTop: '0.3rem' }} />
      <span>
        <span>{label}</span>
        {hint && <span class="text-sm text-muted-foreground block">{hint}</span>}
      </span>
    </label>
  );
}

function CameraPicker({ cameras, selected, disabled, onChange }) {
  const [filter, setFilter] = useState('');
  const shown = cameras.filter((name) => name.toLowerCase().includes(filter.trim().toLowerCase()));
  const chosen = new Set(selected);
  const toggle = (name) => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name); else next.add(name);
    onChange([...next]);
  };
  return (
    <div data-testid="nas-backup-camera-picker" style={{ border: '1px solid hsl(var(--border))', borderRadius: '0.5rem', padding: '0.5rem', marginTop: '0.5rem' }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
        <input type="search" class={inputClass} style={{ flex: '1 1 12rem', width: 'auto' }} placeholder="Search cameras"
          value={filter} disabled={disabled} onInput={(event) => setFilter(event.currentTarget.value)} />
        <button type="button" class="btn-secondary" disabled={disabled}
          onClick={() => onChange([...new Set([...selected, ...shown])])}>Select shown</button>
        <button type="button" class="btn-secondary" disabled={disabled}
          onClick={() => onChange(selected.filter((name) => !shown.includes(name)))}>Clear shown</button>
      </div>
      <div style={{ maxHeight: '14rem', overflowY: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(12rem, 1fr))', gap: '0.25rem 1rem' }}>
        {shown.map((name) => (
          <label key={name} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}>
            <input type="checkbox" checked={chosen.has(name)} disabled={disabled} onChange={() => toggle(name)}
              style={{ accentColor: 'hsl(var(--primary))' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={name}>{name}</span>
          </label>
        ))}
        {shown.length === 0 && <span class="text-sm text-muted-foreground">No cameras match.</span>}
      </div>
      <div class="text-sm text-muted-foreground" style={{ marginTop: '0.4rem' }}>{selected.length} of {cameras.length} cameras selected</div>
    </div>
  );
}

function BackupStatus({ status }) {
  if (!status) return null;
  const waiting = Number(status.queue_waiting) || 0;
  const stateText = {
    copying: `Copying${status.current ? ` ${status.current}` : ''}…`,
    up_to_date: 'Up to date',
    waiting_schedule: 'Waiting for the backup time window',
    nas_unavailable: 'Paused: the NAS is not reachable (recordings wait on this server)',
    error: 'Retrying after an error',
    off: 'Starting…',
  }[status.state] || status.state;
  const items = [
    ['Backup', stateText],
    ['Waiting', waiting > 0 ? `${waiting} recordings (${formatBytes(status.queue_bytes)}), backed up until ${formatTime(status.backed_up_until)}` : 'Nothing'],
    ['Copied today', `${status.copied_today || 0} recordings (${formatBytes(status.copied_today_bytes)})${status.last_speed_mbps ? `, last at ${Number(status.last_speed_mbps).toFixed(1)} Mbit/s` : ''}`],
    ['On the NAS', `${status.backups_total || 0} recordings (${formatBytes(status.backups_bytes)})`],
  ];
  return (
    <div data-testid="nas-backup-status" data-state={status.state}
      style={{ border: '1px solid hsl(var(--border))', borderRadius: '0.5rem', padding: '0.6rem 0.9rem', marginBottom: '1rem', background: 'hsl(var(--muted) / 0.25)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.2rem 1rem' }} class="text-sm">
        {items.map(([label, value]) => [
          <span key={`${label}-l`} class="text-muted-foreground">{label}</span>,
          <span key={`${label}-v`}>{value}</span>,
        ])}
      </div>
      {status.error && status.state === 'error' && (
        <div class="text-sm" style={{ marginTop: '0.4rem', color: 'hsl(0 75% 50%)' }}>Last error: {status.error}</div>
      )}
    </div>
  );
}

export function NasStorageSettings({ canModify }) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({ type: 'nfs', server: '', share: '', username: '', password: '', version: '4.1' });
  const [role, setRole] = useState('backup');
  const [backup, setBackup] = useState(DEFAULT_BACKUP);
  const [cameraNames, setCameraNames] = useState([]);
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
      // Not connected yet: suggest backup (works on any network)
      setRole(data.enabled ? (data.role || 'main') : 'backup');
      setBackup(backupFrom(data));
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
    fetchJSON('/api/streams', { timeout: 15000 })
      .then((streams) => {
        if (!cancelled && Array.isArray(streams)) {
          setCameraNames(streams.map((stream) => stream.name).filter(Boolean).sort((a, b) => a.localeCompare(b)));
        }
      })
      .catch(() => {});
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
  const updateBackup = (field, value) => setBackup((previous) => ({ ...previous, [field]: value }));

  const options = () => {
    const { cameraMode, ...rest } = backup;
    return { role, backup: { ...rest, cameras: cameraMode === 'all' ? [] : backup.cameras } };
  };
  const body = () => JSON.stringify({
    type: form.type,
    server: form.server.trim(),
    share: form.share.trim(),
    username: form.type === 'smb' ? form.username.trim() : '',
    password: form.type === 'smb' ? form.password : '',
    version: form.version,
    ...options(),
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

  const connectedMessage = (data) => (data.role === 'backup'
    ? 'NAS connected as backup. Recordings are copied to the NAS in the background.'
    : 'NAS connected. New recordings are saved on the NAS.');

  const connect = async () => {
    setBusy('connect');
    setTestResult(null);
    try {
      const result = await fetchJSON('/api/storage/nas/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(), timeout: 90000,
      });
      applySaved(result, true);
      showStatusMessage(result.warning || connectedMessage(result), result.warning ? 'warning' : 'success', 6000);
    } catch (error) {
      setTestResult({ ok: false, message: error.message || 'Could not connect' });
    } finally {
      setBusy('');
    }
  };

  const saveOptions = async () => {
    setBusy('options');
    try {
      const result = await fetchJSON('/api/storage/nas/options', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options()), timeout: 30000,
      });
      applySaved(result, true);
      showStatusMessage(result.warning || (result.role === 'backup' ? 'Backup settings saved.' : 'NAS now used for recording.'),
        result.warning ? 'warning' : 'success', 5000);
    } catch (error) {
      showStatusMessage(error.message || 'Could not save', 'error', 6000);
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    const text = saved?.role === 'backup'
      ? 'Disconnect the backup NAS? Copying stops. Backups already on the NAS stay there; recordings that only exist on the NAS cannot be played while it is disconnected.'
      : 'Disconnect the NAS? New recordings will be saved on this server\'s disk. Recordings already on the NAS stay there, but cannot be played while it is disconnected.';
    if (!window.confirm(text)) return;
    setBusy('disconnect');
    try {
      const result = await fetchJSON('/api/storage/nas/disconnect', { method: 'POST', timeout: 30000 });
      applySaved(result, false);
      showStatusMessage('NAS disconnected. Recordings are saved on this server\'s disk.');
    } catch (error) {
      showStatusMessage(error.message || 'Could not disconnect', 'error', 6000);
    } finally {
      setBusy('');
    }
  };

  const savedBackup = useMemo(() => backupFrom(saved), [saved]);

  if (!loaded) return null;

  const status = saved?.status || { state: 'disabled' };
  const enabled = Boolean(saved?.enabled);
  const savedRole = saved?.role || 'main';
  const space = status.total_bytes ? `${formatBytes(status.free_bytes)} free of ${formatBytes(status.total_bytes)}` : '';
  const serverLabel = `${saved?.type === 'smb' ? 'SMB' : 'NFS'} //${saved?.server}`;
  let statusView;
  if (!enabled) {
    statusView = { tone: 'muted', title: 'Not connected', text: 'Recordings are saved on this server\'s disk.' };
  } else if (savedRole === 'backup') {
    statusView = status.state === 'connected'
      ? { tone: 'ok', title: `Backup NAS connected: ${serverLabel}`, text: `Cameras record to this server; recordings are copied to the NAS.${space ? ` ${space}.` : ''}` }
      : { tone: 'bad', title: 'Backup NAS not reachable', text: `Recording continues on this server's disk; copying resumes when the NAS is back.${status.error ? ` (${status.error})` : ''}` };
  } else {
    statusView = status.state === 'connected'
      ? { tone: 'ok', title: `Connected to ${serverLabel}`, text: `New recordings are saved on the NAS.${space ? ` ${space}.` : ''}` }
      : { tone: 'bad', title: 'NAS not reachable', text: `Recordings are saved on this server's disk until the NAS is back.${status.error ? ` (${status.error})` : ''}` };
  }
  const toneStyle = {
    ok: { borderColor: 'hsl(142 70% 40% / 0.45)', background: 'hsl(142 70% 40% / 0.08)' },
    bad: { borderColor: 'hsl(0 75% 50% / 0.45)', background: 'hsl(0 75% 50% / 0.07)' },
    muted: { borderColor: 'hsl(var(--border))', background: 'hsl(var(--muted) / 0.35)' },
  }[statusView.tone];
  const dotColor = { ok: 'hsl(142 70% 40%)', bad: 'hsl(0 75% 50%)', muted: 'hsl(var(--muted-foreground))' }[statusView.tone];
  const connectionChanged = enabled && (form.type !== saved.type || form.server.trim() !== saved.server || form.share.trim() !== saved.share
    || form.username.trim() !== (saved.username || '') || form.password !== '' || form.version !== saved.version);
  const optionsChanged = enabled && (role !== savedRole || (role === 'backup' && !sameBackup(backup, savedBackup)));
  const disabled = !canModify || Boolean(busy);
  const cameraMode = backup.cameras.length > 0 || backup.cameraMode === 'selected' ? 'selected' : 'all';
  const noCamerasChosen = role === 'backup' && cameraMode === 'selected' && backup.cameras.length === 0;

  return (
    <div class="settings-group bg-card text-card-foreground rounded-lg shadow p-4" data-testid="nas-settings">
      <h3 class="text-lg font-semibold mb-4 pb-2 border-b border-border">Network Storage (NAS)</h3>

      <div data-testid="nas-status" data-state={enabled ? status.state : 'disabled'} data-role={enabled ? savedRole : ''}
        style={{ border: '1px solid', ...toneStyle, borderRadius: '0.5rem', padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <span aria-hidden="true" style={{ width: '0.6rem', height: '0.6rem', borderRadius: '999px', background: dotColor, marginTop: '0.4rem', flex: '0 0 auto' }} />
        <div>
          <div class="font-medium">{statusView.title}</div>
          <div class="text-sm text-muted-foreground">{statusView.text}</div>
        </div>
      </div>

      {enabled && savedRole === 'backup' && <BackupStatus status={saved?.backup?.status} />}

      <div class={rowClass}>
        <span class="font-medium">Type</span>
        <div class="col-span-2" role="radiogroup" aria-label="NAS type" style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
          {[['nfs', 'NFS (Linux, Synology, QNAP)'], ['smb', 'SMB / Windows share']].map(([value, label]) => (
            <label key={value} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
              <input type="radio" name="nas-type" value={value} checked={form.type === value} disabled={disabled}
                onChange={() => update('type', value)} style={{ accentColor: 'hsl(var(--primary))' }} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </div>

      <div class={rowClass}>
        <label for="nas-server" class="font-medium">NAS address</label>
        <div class="col-span-2">
          <input id="nas-server" data-testid="nas-server" type="text" class={inputClass} placeholder="e.g. 192.168.1.50"
            value={form.server} disabled={disabled} autoComplete="off" spellCheck={false}
            onInput={(event) => update('server', event.currentTarget.value)} />
        </div>
      </div>

      <div class={rowClass}>
        <label for="nas-share" class="font-medium">Shared folder</label>
        <div class="col-span-2">
          <input id="nas-share" data-testid="nas-share" type="text" class={inputClass}
            placeholder={form.type === 'nfs' ? 'e.g. /volume1/recordings' : 'e.g. recordings'}
            value={form.share} disabled={disabled} autoComplete="off" spellCheck={false}
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
          <div class={rowClass}>
            <label for="nas-username" class="font-medium">User name</label>
            <div class="col-span-2">
              <input id="nas-username" data-testid="nas-username" type="text" class={inputClass} placeholder="Leave empty for guest access"
                value={form.username} disabled={disabled} autoComplete="off" spellCheck={false}
                onInput={(event) => update('username', event.currentTarget.value)} />
            </div>
          </div>
          <div class={rowClass}>
            <label for="nas-password" class="font-medium">Password</label>
            <div class="col-span-2">
              <input id="nas-password" data-testid="nas-password" type="password" class={inputClass}
                placeholder={saved?.has_password ? 'Saved (leave empty to keep it)' : ''}
                value={form.password} disabled={disabled} autoComplete="new-password"
                onInput={(event) => update('password', event.currentTarget.value)} />
            </div>
          </div>
        </>
      )}

      <div class={rowClass}>
        <label for="nas-version" class="font-medium">{form.type === 'nfs' ? 'NFS version' : 'SMB version'}</label>
        <div class="col-span-2">
          <select id="nas-version" class={selectClass}
            value={form.version} disabled={disabled} onChange={(event) => update('version', event.currentTarget.value)}>
            {VERSIONS[form.type].map((version) => <option key={version} value={version}>{version}</option>)}
          </select>
          <span class="hint text-sm text-muted-foreground" style={{ marginLeft: '0.5rem' }}>Keep the default unless the NAS needs another.</span>
        </div>
      </div>

      <div class={rowClass} style={{ paddingTop: '0.75rem', borderTop: '1px solid hsl(var(--border))' }}>
        <span class="font-medium">Use the NAS for</span>
        <div class="col-span-2" role="radiogroup" aria-label="NAS role" style={{ display: 'grid', gap: '0.6rem' }}>
          <Radio name="nas-role" value="backup" testId="nas-role-backup" checked={role === 'backup'} disabled={disabled}
            onChange={() => setRole('backup')} label="Backup (recommended)"
            hint="Cameras record to this server's disk; recordings are copied to the NAS in the background. Recording never depends on the NAS or the network." />
          <Radio name="nas-role" value="main" testId="nas-role-main" checked={role === 'main'} disabled={disabled}
            onChange={() => setRole('main')} label="Recording"
            hint="Cameras record straight to the NAS. Needs a fast, reliable network (gigabit) between this server and the NAS." />
        </div>
      </div>

      {role === 'backup' && (
        <div data-testid="nas-backup-options">
          <div class={rowClass}>
            <span class="font-medium">When to copy</span>
            <div class="col-span-2" style={{ display: 'grid', gap: '0.5rem' }}>
              <Radio name="nas-backup-when" value="realtime" testId="nas-backup-realtime" checked={backup.when === 'realtime'} disabled={disabled}
                onChange={() => updateBackup('when', 'realtime')} label="Real time" hint="Each recording is copied as soon as it is finished." />
              <Radio name="nas-backup-when" value="schedule" testId="nas-backup-schedule" checked={backup.when === 'schedule'} disabled={disabled}
                onChange={() => updateBackup('when', 'schedule')} label="On a schedule" hint="Copy only in a daily time window, e.g. at night." />
              {backup.when === 'schedule' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', paddingLeft: '1.5rem' }}>
                  <span>From</span>
                  <select class={selectClass} data-testid="nas-backup-from" value={backup.schedule_start_hour} disabled={disabled}
                    onChange={(event) => updateBackup('schedule_start_hour', Number(event.currentTarget.value))}>
                    {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                  </select>
                  <span>to</span>
                  <select class={selectClass} data-testid="nas-backup-to" value={backup.schedule_end_hour} disabled={disabled}
                    onChange={(event) => updateBackup('schedule_end_hour', Number(event.currentTarget.value))}>
                    {HOURS.map((hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
                  </select>
                  {backup.schedule_start_hour === backup.schedule_end_hour && (
                    <span class="text-sm" style={{ color: 'hsl(0 75% 50%)' }}>Start and end must differ.</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div class={rowClass}>
            <label for="nas-backup-bw" class="font-medium">Speed limit</label>
            <div class="col-span-2">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <input id="nas-backup-bw" data-testid="nas-backup-bw" type="number" min="0" step="1" class={inputClass} style={{ maxWidth: '8rem' }}
                  value={backup.bwlimit_mbps} disabled={disabled}
                  onInput={(event) => updateBackup('bwlimit_mbps', Math.max(0, parseInt(event.currentTarget.value, 10) || 0))} />
                <span>Mbit/s</span>
              </div>
              <span class="hint text-sm text-muted-foreground block mt-1">
                0 = no limit. On a 100 Mbit network keep it below the free capacity (e.g. 40–60) so live view and cameras are not slowed down.
              </span>
            </div>
          </div>

          <div class={rowClass}>
            <span class="font-medium">What to copy</span>
            <div class="col-span-2" style={{ display: 'grid', gap: '0.5rem' }}>
              <Radio name="nas-backup-what" value="all" checked={!backup.events_only} disabled={disabled}
                onChange={() => updateBackup('events_only', false)} label="All recordings" />
              <Radio name="nas-backup-what" value="events" testId="nas-backup-events" checked={backup.events_only} disabled={disabled}
                onChange={() => updateBackup('events_only', true)} label="Only motion and detection recordings" />
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                <input type="checkbox" data-testid="nas-backup-existing" checked={backup.include_existing} disabled={disabled}
                  onChange={(event) => updateBackup('include_existing', event.currentTarget.checked)}
                  style={{ accentColor: 'hsl(var(--primary))', marginTop: '0.3rem' }} />
                <span>Also copy recordings made before backup was turned on</span>
              </label>
            </div>
          </div>

          <div class={rowClass}>
            <span class="font-medium">Cameras</span>
            <div class="col-span-2" style={{ display: 'grid', gap: '0.5rem' }}>
              <Radio name="nas-backup-cams" value="all" checked={cameraMode === 'all'} disabled={disabled}
                onChange={() => setBackup((previous) => ({ ...previous, cameras: [], cameraMode: 'all' }))} label="All cameras" />
              <Radio name="nas-backup-cams" value="selected" testId="nas-backup-selected" checked={cameraMode === 'selected'} disabled={disabled}
                onChange={() => updateBackup('cameraMode', 'selected')} label="Selected cameras" />
              {cameraMode === 'selected' && (
                <CameraPicker cameras={cameraNames} selected={backup.cameras} disabled={disabled}
                  onChange={(cameras) => setBackup((previous) => ({ ...previous, cameras, cameraMode: 'selected' }))} />
              )}
            </div>
          </div>

          <div class={rowClass}>
            <span class="font-medium">After backup</span>
            <div class="col-span-2" style={{ display: 'grid', gap: '0.5rem' }}>
              <Radio name="nas-backup-local" value="keep" checked={!backup.delete_local} disabled={disabled}
                onChange={() => updateBackup('delete_local', false)} label="Keep the local copy"
                hint="Two copies. Local retention removes the local copy later; the recording then plays from the NAS." />
              <Radio name="nas-backup-local" value="delete" testId="nas-backup-move" checked={backup.delete_local} disabled={disabled}
                onChange={() => updateBackup('delete_local', true)} label="Delete the local copy (move to the NAS)"
                hint="Frees this server's disk right after each copy is checked. The recording then exists only on the NAS." />
            </div>
          </div>

          <div class={rowClass}>
            <span class="font-medium">Backup retention</span>
            <div class="col-span-2" style={{ display: 'grid', gap: '0.5rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>Keep</span>
                <input type="number" min="1" step="1" data-testid="nas-backup-reserve" class={inputClass} style={{ maxWidth: '7rem' }}
                  value={backup.reserve_gb} disabled={disabled}
                  onInput={(event) => updateBackup('reserve_gb', Math.max(1, parseInt(event.currentTarget.value, 10) || 1))} />
                <span>GB free on the NAS (the oldest backups are deleted first)</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>Delete backups older than</span>
                <input type="number" min="0" step="1" data-testid="nas-backup-days" class={inputClass} style={{ maxWidth: '7rem' }}
                  value={backup.keep_days} disabled={disabled}
                  onInput={(event) => updateBackup('keep_days', Math.max(0, parseInt(event.currentTarget.value, 10) || 0))} />
                <span>days (0 = keep until the NAS is full)</span>
              </div>
            </div>
          </div>
        </div>
      )}

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
          {enabled && optionsChanged && !connectionChanged && (
            <button type="button" class="btn-primary" data-testid="nas-save-options" disabled={Boolean(busy) || noCamerasChosen} onClick={saveOptions}>
              {busy === 'options' ? 'Saving…' : 'Save'}
            </button>
          )}
          {(!enabled || connectionChanged) && (
            <button type="button" class="btn-primary" data-testid="nas-connect" disabled={missing || Boolean(busy) || noCamerasChosen} onClick={connect}>
              {busy === 'connect' ? 'Connecting…' : (enabled ? 'Save and reconnect' : 'Connect')}
            </button>
          )}
        </div>
      )}
      {noCamerasChosen && (
        <p class="text-sm" style={{ marginTop: '0.5rem', color: 'hsl(0 75% 50%)', textAlign: 'right' }}>Select at least one camera, or choose All cameras.</p>
      )}
      <p class="text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        {role === 'backup'
          ? 'Backups are checked against the recording before they count. Recordings that are only on the NAS keep playing from there while it is connected.'
          : 'Only new recordings go to the NAS; recordings already on this server stay here and can still be played. Retention and "delete oldest when full" apply to the NAS while it is connected.'}
      </p>
    </div>
  );
}
