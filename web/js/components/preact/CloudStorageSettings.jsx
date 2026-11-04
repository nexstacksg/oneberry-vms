/**
 * Settings → Cloud Storage: upload finished recordings to S3-compatible
 * storage (AWS, Wasabi, Backblaze B2, Cloudflare R2, MinIO) or Azure Blob.
 * Recordings are still made on this server; uploads run in the background
 * and wait in a queue while the internet or the cloud is not reachable.
 */
import { useEffect, useState } from 'preact/hooks';
import { fetchJSON } from '../../query-client.js';
import { showStatusMessage } from './ToastContainer.jsx';

// Service -> how it is stored (provider, s3_provider) and what to ask for
const SERVICES = {
  aws: { label: 'Amazon S3', provider: 's3', s3: 'AWS', endpoint: false, region: 'e.g. ap-southeast-1' },
  wasabi: { label: 'Wasabi', provider: 's3', s3: 'Wasabi', endpoint: 'https://s3.ap-southeast-1.wasabisys.com', region: 'e.g. ap-southeast-1' },
  b2: { label: 'Backblaze B2', provider: 's3', s3: 'Other', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'e.g. us-west-004' },
  r2: { label: 'Cloudflare R2', provider: 's3', s3: 'Cloudflare', endpoint: 'https://<account-id>.r2.cloudflarestorage.com', region: 'auto' },
  minio: { label: 'MinIO (own server)', provider: 's3', s3: 'Minio', endpoint: 'http://192.168.1.60:9000', region: '' },
  other: { label: 'Other S3-compatible', provider: 's3', s3: 'Other', endpoint: 'https://s3.example.com', region: '' },
  azure: { label: 'Azure Blob Storage', provider: 'azureblob', s3: '', endpoint: false, region: false },
};

function serviceFromSaved(data) {
  if (data.provider === 'azureblob') return 'azure';
  if (data.s3_provider === 'Wasabi') return 'wasabi';
  if (data.s3_provider === 'Cloudflare') return 'r2';
  if (data.s3_provider === 'Minio') return 'minio';
  if (data.s3_provider === 'Other') return /backblaze/i.test(data.endpoint || '') ? 'b2' : 'other';
  return 'aws';
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 100 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

const inputClass = 'w-full p-2 border border-input rounded bg-background text-foreground disabled:opacity-60 disabled:cursor-not-allowed';

function Row({ id, label, hint, children }) {
  return (
    <div class="setting grid grid-cols-1 md:grid-cols-3 gap-4 items-center mb-4">
      <label for={id} class="font-medium">{label}</label>
      <div class="col-span-2">
        {children}
        {hint && <span class="hint text-sm text-muted-foreground block mt-1">{hint}</span>}
      </div>
    </div>
  );
}

export function CloudStorageSettings({ canModify }) {
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState({
    service: 'aws', endpoint: '', region: '', bucket: '', access_key: '', secret_key: '',
    prefix: 'oneberry', events_only: false, bwlimit_mbps: 0,
  });
  const [busy, setBusy] = useState('');
  const [testResult, setTestResult] = useState(null);

  const applySaved = (data, resetForm) => {
    setSaved(data);
    if (resetForm && data.bucket) {
      setForm({
        service: serviceFromSaved(data),
        endpoint: data.endpoint || '',
        region: data.region || '',
        bucket: data.bucket || '',
        access_key: data.access_key || '',
        secret_key: '',
        prefix: data.prefix ?? 'oneberry',
        events_only: Boolean(data.events_only),
        bwlimit_mbps: Number(data.bwlimit_mbps) || 0,
      });
    }
  };

  // Settings once, then the queue status every 10 s
  useEffect(() => {
    let cancelled = false;
    const load = async (first) => {
      try {
        const data = await fetchJSON('/api/storage/cloud', { timeout: 10000 });
        if (!cancelled) {
          applySaved(data, first);
          setLoaded(true);
        }
      } catch {
        if (!cancelled && first) setLoaded(true);
      }
    };
    load(true);
    const timer = setInterval(() => load(false), 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const service = SERVICES[form.service];
  const isAzure = service.provider === 'azureblob';

  const update = (field, value) => {
    setTestResult(null);
    setForm((previous) => {
      const next = { ...previous, [field]: value };
      if (field === 'service') {
        next.endpoint = '';
        next.region = SERVICES[value].region === 'auto' ? 'auto' : '';
      }
      return next;
    });
  };

  const body = () => JSON.stringify({
    provider: service.provider,
    s3_provider: service.s3,
    endpoint: service.endpoint === false ? '' : form.endpoint.trim(),
    region: service.region === false ? '' : form.region.trim(),
    bucket: form.bucket.trim(),
    access_key: form.access_key.trim(),
    secret_key: form.secret_key,
    prefix: form.prefix.trim(),
    events_only: form.events_only,
    bwlimit_mbps: Math.max(0, Number(form.bwlimit_mbps) || 0),
  });

  const missing = !form.bucket.trim() || !form.access_key.trim()
    || (!form.secret_key && !saved?.has_secret)
    || (service.endpoint !== false && !form.endpoint.trim());

  const testConnection = async () => {
    setBusy('test');
    setTestResult(null);
    try {
      setTestResult(await fetchJSON('/api/storage/cloud/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(), timeout: 150000,
      }));
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
      const result = await fetchJSON('/api/storage/cloud/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body(), timeout: 150000,
      });
      applySaved(result, true);
      showStatusMessage(result.warning || 'Cloud storage connected. New recordings will be uploaded.', result.warning ? 'warning' : 'success', 6000);
    } catch (error) {
      setTestResult({ ok: false, message: error.message || 'Could not connect' });
    } finally {
      setBusy('');
    }
  };

  const disconnect = async () => {
    if (!window.confirm('Stop uploading recordings to the cloud? Recordings already uploaded stay in the cloud; recordings still waiting are not uploaded.')) return;
    setBusy('disconnect');
    try {
      applySaved(await fetchJSON('/api/storage/cloud/disconnect', { method: 'POST', timeout: 30000 }), false);
      showStatusMessage('Cloud storage disconnected. Recordings are no longer uploaded.');
    } catch (error) {
      showStatusMessage(error.message || 'Could not disconnect', 'error', 6000);
    } finally {
      setBusy('');
    }
  };

  if (!loaded) return null;

  const status = saved?.status || { state: 'disabled' };
  const enabled = Boolean(saved?.enabled);
  const savedService = saved?.bucket ? SERVICES[serviceFromSaved(saved)].label : '';
  const counts = `${status.queue_waiting || 0} waiting · ${formatBytes(status.uploaded_today_bytes)} uploaded today (${status.uploaded_today || 0} recordings)`;
  const view = !enabled
    ? { tone: 'muted', title: 'Not connected', text: 'Recordings are kept on this server only.' }
    : status.state === 'error'
      ? { tone: 'bad', title: 'Uploads are failing', text: `${status.error || 'The cloud is not reachable'}. Recordings wait and are uploaded when it works again. ${counts}.` }
      : { tone: 'ok', title: `Connected to ${savedService} · ${saved.bucket}${saved.prefix ? `/${saved.prefix}` : ''}`, text: `${saved.events_only ? 'Motion and detection recordings' : 'New recordings'} are uploaded. ${counts}.` };
  const tone = {
    ok: { borderColor: 'hsl(142 70% 40% / 0.45)', background: 'hsl(142 70% 40% / 0.08)', dot: 'hsl(142 70% 40%)' },
    bad: { borderColor: 'hsl(0 75% 50% / 0.45)', background: 'hsl(0 75% 50% / 0.07)', dot: 'hsl(0 75% 50%)' },
    muted: { borderColor: 'hsl(var(--border))', background: 'hsl(var(--muted) / 0.35)', dot: 'hsl(var(--muted-foreground))' },
  }[view.tone];
  const changed = enabled && saved && (
    serviceFromSaved(saved) !== form.service || (saved.endpoint || '') !== form.endpoint.trim()
    || (saved.region || '') !== form.region.trim() || saved.bucket !== form.bucket.trim()
    || saved.access_key !== form.access_key.trim() || form.secret_key !== '' || (saved.prefix || '') !== form.prefix.trim()
    || Boolean(saved.events_only) !== form.events_only || (Number(saved.bwlimit_mbps) || 0) !== (Number(form.bwlimit_mbps) || 0));
  const disabled = !canModify || Boolean(busy);

  return (
    <div class="settings-group bg-card text-card-foreground rounded-lg shadow p-4" data-testid="cloud-settings">
      <h3 class="text-lg font-semibold mb-4 pb-2 border-b border-border">Cloud Storage</h3>

      <div data-testid="cloud-status" data-state={enabled ? status.state : 'disabled'}
        style={{ border: '1px solid', borderColor: tone.borderColor, background: tone.background, borderRadius: '0.5rem', padding: '0.75rem 1rem', marginBottom: '1rem', display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <span aria-hidden="true" style={{ width: '0.6rem', height: '0.6rem', borderRadius: '999px', background: tone.dot, marginTop: '0.4rem', flex: '0 0 auto' }} />
        <div>
          <div class="font-medium">{view.title}</div>
          <div class="text-sm text-muted-foreground">{view.text}</div>
        </div>
      </div>

      <Row id="cloud-service" label="Service">
        <select id="cloud-service" data-testid="cloud-service" class="p-2 border border-input rounded bg-background text-foreground disabled:opacity-60"
          value={form.service} disabled={disabled} onChange={(event) => update('service', event.currentTarget.value)}>
          {Object.entries(SERVICES).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
        </select>
      </Row>

      {service.endpoint !== false && (
        <Row id="cloud-endpoint" label="Endpoint URL" hint={`The S3 address of your ${service.label} storage.`}>
          <input id="cloud-endpoint" data-testid="cloud-endpoint" type="text" class={inputClass} placeholder={service.endpoint}
            value={form.endpoint} disabled={disabled} autoComplete="off" spellCheck={false}
            onInput={(event) => update('endpoint', event.currentTarget.value)} />
        </Row>
      )}
      {service.region !== false && (
        <Row id="cloud-region" label="Region">
          <input id="cloud-region" data-testid="cloud-region" type="text" class={inputClass} placeholder={service.region || 'Leave empty if not needed'}
            value={form.region} disabled={disabled} autoComplete="off" spellCheck={false}
            onInput={(event) => update('region', event.currentTarget.value)} />
        </Row>
      )}
      <Row id="cloud-bucket" label={isAzure ? 'Container' : 'Bucket'} hint={`Create the ${isAzure ? 'container' : 'bucket'} in the ${service.label} console first.`}>
        <input id="cloud-bucket" data-testid="cloud-bucket" type="text" class={inputClass} value={form.bucket} disabled={disabled}
          autoComplete="off" spellCheck={false} onInput={(event) => update('bucket', event.currentTarget.value)} />
      </Row>
      <Row id="cloud-access" label={isAzure ? 'Storage account name' : 'Access key ID'}>
        <input id="cloud-access" data-testid="cloud-access" type="text" class={inputClass} value={form.access_key} disabled={disabled}
          autoComplete="off" spellCheck={false} onInput={(event) => update('access_key', event.currentTarget.value)} />
      </Row>
      <Row id="cloud-secret" label={isAzure ? 'Account key' : 'Secret access key'}>
        <input id="cloud-secret" data-testid="cloud-secret" type="password" class={inputClass} value={form.secret_key} disabled={disabled}
          placeholder={saved?.has_secret ? 'Saved (leave empty to keep it)' : ''} autoComplete="new-password"
          onInput={(event) => update('secret_key', event.currentTarget.value)} />
      </Row>
      <Row id="cloud-prefix" label="Folder in the bucket" hint="Recordings are stored as folder/camera/year/month/day/file.mp4.">
        <input id="cloud-prefix" data-testid="cloud-prefix" type="text" class={inputClass} value={form.prefix} disabled={disabled}
          autoComplete="off" spellCheck={false} onInput={(event) => update('prefix', event.currentTarget.value)} />
      </Row>
      <Row id="cloud-what" label="What to upload">
        <div role="radiogroup" aria-label="What to upload" style={{ display: 'flex', flexWrap: 'wrap', gap: '1.25rem' }}>
          {[[false, 'All recordings'], [true, 'Only motion and detection recordings']].map(([value, label]) => (
            <label key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
              <input type="radio" name="cloud-what" data-testid={value ? 'cloud-events-only' : 'cloud-all'} checked={form.events_only === value} disabled={disabled}
                onChange={() => update('events_only', value)} style={{ accentColor: 'hsl(var(--primary))' }} />
              <span>{label}</span>
            </label>
          ))}
        </div>
      </Row>
      <Row id="cloud-bw" label="Upload speed limit" hint="Mbit/s for all uploads together; 0 = no limit. Keep some bandwidth for live viewing.">
        <input id="cloud-bw" data-testid="cloud-bw" type="number" min="0" class="p-2 border border-input rounded bg-background text-foreground disabled:opacity-60"
          style={{ width: '8rem' }} value={form.bwlimit_mbps} disabled={disabled}
          onInput={(event) => update('bwlimit_mbps', event.currentTarget.value)} />
      </Row>

      {testResult && (
        <div data-testid="cloud-test-result" role="status"
          style={{ border: '1px solid', borderRadius: '0.5rem', padding: '0.6rem 0.9rem', marginBottom: '1rem',
            ...(testResult.ok ? { borderColor: 'hsl(142 70% 40% / 0.45)', background: 'hsl(142 70% 40% / 0.08)' } : { borderColor: 'hsl(0 75% 50% / 0.45)', background: 'hsl(0 75% 50% / 0.07)' }) }}>
          <span class="font-medium">{testResult.ok ? 'Test passed: ' : 'Test failed: '}</span>
          <span class="text-sm">{testResult.message}</span>
        </div>
      )}

      {canModify && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'flex-end' }}>
          <button type="button" class="btn-secondary" data-testid="cloud-test" disabled={missing || Boolean(busy)} onClick={testConnection}>
            {busy === 'test' ? 'Testing…' : 'Test connection'}
          </button>
          {enabled && (
            <button type="button" class="btn-secondary" data-testid="cloud-disconnect" disabled={Boolean(busy)} onClick={disconnect}>
              {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
            </button>
          )}
          {(!enabled || changed) && (
            <button type="button" class="btn-primary" data-testid="cloud-connect" disabled={missing || Boolean(busy)} onClick={connect}>
              {busy === 'connect' ? 'Connecting…' : (enabled ? 'Save and reconnect' : 'Connect')}
            </button>
          )}
        </div>
      )}
      <p class="text-sm text-muted-foreground" style={{ marginTop: '0.75rem' }}>
        Recordings made after connecting are uploaded when each one finishes; they stay on this server as well.
        This server needs internet access (or access to your own MinIO server).
      </p>
    </div>
  );
}
