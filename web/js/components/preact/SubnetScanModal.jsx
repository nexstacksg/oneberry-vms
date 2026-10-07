/**
 * Add Device → Subnet Scan: scan an IP range for ONVIF and RTSP cameras with
 * common credentials, then connect the selected ones.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { fetchJSON } from '../../query-client.js';
import {
  DEFAULT_RTSP_PORT,
  connectSelectedDevices,
  devicePortLabel,
  deviceStatusLabel,
  isDeviceSelectable,
  validateIpRange,
  validatePort,
} from '../../utils/subnet-scan-utils.js';

const SCAN_API = '/api/discovery/subnet-scan';
const POLL_INTERVAL_MS = 1000;

const inputClass = 'w-full h-10 px-3 border border-input rounded-md bg-background text-foreground text-sm shadow-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 focus:ring-primary/60 focus:border-primary disabled:opacity-60 disabled:cursor-not-allowed';
const sectionLabelClass = 'text-[11px] font-medium uppercase tracking-wide text-muted-foreground';
const pillBase = 'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';

// Small inline icon (24x24 stroke paths)
const ICONS = {
  radar: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M12 12l6-6',
  search: 'M21 21l-4.35-4.35M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z',
  stop: 'M7 7h10v10H7z',
  key: 'M15 7a3 3 0 1 1-2.83 4H10v2H8v2H6v-3.17l4.17-4.17A3 3 0 0 1 15 7z',
  eye: 'M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A9.7 9.7 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2.5 12 2.5 12s3.5 7 9.5 7a9.8 9.8 0 0 0 5.4-1.6',
  plug: 'M9 7V3m6 4V3M7 7h10v4a5 5 0 0 1-10 0V7zm5 9v5',
  check: 'M5 13l4 4L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  alert: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 16v-4m0-4h.01M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
  shield: 'M12 3l7 3v6c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V6l7-3z',
};
const Icon = ({ name, className = 'w-4 h-4' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICONS[name]} />
  </svg>
);
const Spinner = ({ className = 'w-4 h-4' }) => (
  <svg className={`${className} animate-spin`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
  </svg>
);

// Status pill colors by label (see deviceStatusLabel)
const STATUS_STYLE = {
  'Ready': 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400',
  'Connected': 'border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-400',
  'Credentials Failed': 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'Needs RTSP path': 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'Camera busy': 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
  'Error': 'border-destructive/30 bg-destructive/10 text-destructive',
  'Connection failed': 'border-destructive/30 bg-destructive/10 text-destructive',
};
const NEUTRAL_PILL = 'border-border bg-muted/40 text-muted-foreground';

function StatusPill({ label }) {
  const busy = label === 'Connecting…' || label === 'Checking…';
  return (
    <span className={`${pillBase} ${STATUS_STYLE[label] || NEUTRAL_PILL}`} data-testid="subnet-scan-status">
      {busy ? <Spinner className="w-3 h-3" />
        : label === 'Connected' ? <Icon name="check" className="w-3 h-3" />
        : label === 'Connection failed' ? <Icon name="x" className="w-3 h-3" />
        : <span className="w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />}
      {label}
    </span>
  );
}

function PasswordInput({ id, value, onInput, disabled, autoFocus }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input id={id} type={visible ? 'text' : 'password'} className={`${inputClass} pr-10`} value={value}
        autoComplete="new-password" disabled={disabled} autoFocus={autoFocus} onInput={onInput} />
      <button type="button" className="absolute inset-y-0 right-0 px-3 text-muted-foreground hover:text-foreground disabled:opacity-50"
        onClick={() => setVisible((v) => !v)} disabled={disabled} aria-label={visible ? 'Hide password' : 'Show password'}>
        <Icon name={visible ? 'eyeOff' : 'eye'} />
      </button>
    </div>
  );
}

function Banner({ tone, icon, children }) {
  const tones = {
    warning: 'border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300',
    error: 'border-destructive/30 bg-destructive/10 text-destructive',
  };
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${tones[tone]}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} className="w-4 h-4 mt-0.5 flex-shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function CredentialDialog({ request, onSubmit, onCancel }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [applyToOthers, setApplyToOthers] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUsername(request?.username || '');
    setPassword('');
    setBusy(false);
  }, [request]);

  if (!request) return null;
  const { device, error, showApplyToOthers } = request;
  const brandModel = [device.brand, device.model].filter((part) => part && part !== 'Unknown').join(' ');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    await onSubmit({ username: username.trim(), password, applyToOthers });
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" data-keyboard-nav-preserve>
      <form className="bg-card text-card-foreground rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
        role="dialog" aria-modal="true" aria-labelledby="subnet-credential-title" onSubmit={submit}>
        <div className="flex items-center gap-3 px-6 pt-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon name="key" className="w-5 h-5" />
          </div>
          <div>
            <h3 id="subnet-credential-title" className="text-lg font-semibold leading-tight">Connect Camera</h3>
            <p className="text-sm text-muted-foreground">Enter this camera's own username and password.</p>
          </div>
        </div>
        <div className="px-6 py-5 space-y-4">
          <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className={sectionLabelClass}>Camera</div>
              <div className="font-mono text-sm">{device.ip}</div>
            </div>
            {brandModel && <span className="text-sm text-muted-foreground truncate">{brandModel}</span>}
          </div>
          {error && <Banner tone="error" icon="alert">{error}</Banner>}
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="subnet-credential-username">Username</label>
            <input id="subnet-credential-username" className={inputClass} value={username} autoFocus autoComplete="off"
              onInput={(event) => setUsername(event.currentTarget.value)} />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5" htmlFor="subnet-credential-password">Password</label>
            <PasswordInput id="subnet-credential-password" value={password} onInput={(event) => setPassword(event.currentTarget.value)} />
          </div>
          {showApplyToOthers && (
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input type="checkbox" className="h-4 w-4 rounded border-input" checked={applyToOthers}
                onChange={(event) => setApplyToOthers(event.currentTarget.checked)} />
              Use these credentials for other failed cameras
            </label>
          )}
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-border bg-muted/20">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary inline-flex items-center gap-2" disabled={busy || !username}>
            {busy ? <Spinner /> : <Icon name="plug" />}
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function SubnetScanModal({ isOpen, onClose, onSwitchToKnownAddress, existingNames = [], onCamerasAdded }) {
  const [startIp, setStartIp] = useState('');
  const [endIp, setEndIp] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [useDefaultPort, setUseDefaultPort] = useState(true);
  const [customPort, setCustomPort] = useState(String(DEFAULT_RTSP_PORT));
  const [formError, setFormError] = useState('');

  const [scan, setScan] = useState(null);          // latest GET /subnet-scan response
  const [devices, setDevices] = useState([]);       // results, updated by retries
  const [selected, setSelected] = useState(() => new Set());
  const [connections, setConnections] = useState({}); // ip -> {state, message, name}
  const [connecting, setConnecting] = useState(false);
  const [credentialRequest, setCredentialRequest] = useState(null);
  const credentialResolver = useRef(null);
  const pollTimer = useRef(null);

  const scanning = scan?.running === true;

  const applyScanStatus = useCallback((status) => {
    setScan(status);
    setDevices(status?.devices || []);
  }, []);

  const stopPolling = () => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  };

  const poll = useCallback(async () => {
    try {
      const status = await fetchJSON(SCAN_API, { timeout: 10000, retries: 1 });
      applyScanStatus(status);
      if (status.running) {
        pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
      }
    } catch (error) {
      setFormError(`Could not read scan progress: ${error.message}`);
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS * 3);
    }
  }, [applyScanStatus]);

  // On open, pick up a scan that is still running (or its last results)
  useEffect(() => {
    if (!isOpen) return undefined;
    poll();
    return stopPolling;
  }, [isOpen, poll]);

  // Forget the password when the dialog closes
  useEffect(() => {
    if (!isOpen) {
      setPassword('');
      setCredentialRequest(null);
      rowCredentials.current = {};
    }
  }, [isOpen]);

  const rangeCheck = validateIpRange(startIp, endIp);
  const portCheck = useDefaultPort ? { valid: true, port: DEFAULT_RTSP_PORT } : validatePort(customPort);

  const startScan = async (event) => {
    event?.preventDefault();
    if (!rangeCheck.valid) { setFormError(rangeCheck.error); return; }
    if (!portCheck.valid) { setFormError(portCheck.error); return; }
    setFormError('');
    setSelected(new Set());
    setConnections({});
    rowCredentials.current = {};
    stopPolling();
    try {
      const status = await fetchJSON(SCAN_API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startIp: startIp.trim(),
          endIp: endIp.trim(),
          username: username.trim(),
          password,
          rtspPort: portCheck.port,
        }),
        timeout: 15000,
        retries: 0,
      });
      applyScanStatus(status);
      pollTimer.current = setTimeout(poll, POLL_INTERVAL_MS);
    } catch (error) {
      setFormError(error.message || 'Could not start the scan');
    }
  };

  const cancelScan = async () => {
    try {
      applyScanStatus(await fetchJSON(SCAN_API, { method: 'DELETE', timeout: 10000, retries: 0 }));
    } catch (error) {
      setFormError(`Could not cancel the scan: ${error.message}`);
    }
  };

  const authenticate = useCallback(async (ip, credentials) => fetchJSON(`${SCAN_API}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, username: credentials.username, password: credentials.password }),
    timeout: 120000,
    retries: 0,
  }), []);

  const updateDevice = (updated) => {
    setDevices((current) => current.map((device) => (device.ip === updated.ip ? updated : device)));
  };

  // Ask for credentials; resolves with {username, password, applyToOthers} or null
  const requestCredentials = (device, error, showApplyToOthers = false) => new Promise((resolve) => {
    credentialResolver.current = resolve;
    setCredentialRequest({ device, error, showApplyToOthers, username: username.trim() });
  });

  const finishCredentialRequest = (value) => {
    const resolve = credentialResolver.current;
    credentialResolver.current = null;
    setCredentialRequest(null);
    if (resolve) resolve(value);
  };

  // Credentials confirmed through a row's "Enter credentials" (ip -> {username, password})
  const rowCredentials = useRef({});

  // Row action: fix credentials for one camera before connecting
  const retryRowCredentials = async (device) => {
    let error = device.message;
    for (;;) {
      const entered = await requestCredentials(device, error);
      if (!entered) return;
      try {
        const updated = await authenticate(device.ip, entered);
        updateDevice(updated);
        if (updated.authStatus === 'ready') {
          setSelected((current) => new Set(current).add(device.ip));
          // keep the working credentials for this camera's connect step
          rowCredentials.current[device.ip] = { username: entered.username, password: entered.password };
          return;
        }
        error = updated.message || 'Authentication failed';
      } catch (retryError) {
        error = retryError.message;
      }
    }
  };

  const selectableDevices = useMemo(
    () => devices.filter((device) => isDeviceSelectable(device, connections[device.ip])),
    [devices, connections]
  );
  const allSelected = selectableDevices.length > 0 && selectableDevices.every((device) => selected.has(device.ip));

  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(selectableDevices.map((device) => device.ip)));
  };
  const toggleOne = (ip) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(ip)) next.delete(ip); else next.add(ip);
      return next;
    });
  };

  const connectSelected = async () => {
    const chosen = devices.filter((device) => selected.has(device.ip) && isDeviceSelectable(device, connections[device.ip]));
    if (chosen.length === 0) return;
    setConnecting(true);
    const failedCount = chosen.filter((device) => device.authStatus === 'credentials_failed').length;

    const results = await connectSelectedDevices(chosen, {
      commonCredentials: { username: username.trim(), password },
      existingNames,
      authenticate,
      deviceCredentials: rowCredentials.current,
      createStream: (payload) => fetchJSON('/api/streams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 45000,
        retries: 0,
      }),
      requestCredentials: (device, error) => requestCredentials(device, error, failedCount > 1),
      onUpdate: (ip, result) => {
        setConnections((current) => ({ ...current, [ip]: result }));
        if (result.device) updateDevice(result.device);
      },
    });

    setConnecting(false);
    setSelected(new Set());
    if (Object.values(results).some((result) => result.state === 'connected')) {
      onCamerasAdded?.();
      poll(); // refresh "Already Added"
    }
  };

  if (!isOpen) return null;

  const percent = (() => {
    if (!scan || !scan.totalHosts) return 0;
    const probing = scan.scannedHosts / scan.totalHosts;
    const checking = scan.candidates ? scan.processed / scan.candidates : (scan.phase === 'done' ? 1 : 0);
    return Math.round((scan.phase === 'probing' ? probing * 0.6 : 0.6 + checking * 0.4) * 100);
  })();
  const connectionSummary = Object.entries(connections).filter(([, result]) => result.state === 'connected' || result.state === 'failed');
  const connectedCount = connectionSummary.filter(([, result]) => result.state === 'connected').length;
  const selectedCount = selectableDevices.filter((device) => selected.has(device.ip)).length;
  const foundCount = scan?.foundCount ?? devices.length;
  const addedCount = devices.filter((device) => device.alreadyAdded).length;
  const attentionCount = devices.filter((device) => !device.alreadyAdded && device.authStatus !== 'ready').length;
  const rangeHint = startIp && endIp
    ? (rangeCheck.valid ? `${rangeCheck.hostCount} address${rangeCheck.hostCount === 1 ? '' : 'es'}` : null)
    : 'Up to 1024 addresses on your local network';
  const rangeError = startIp && endIp && !rangeCheck.valid ? rangeCheck.error : '';
  const probingDone = scan?.phase !== 'probing';

  return (
    <div className="content-modal-backdrop fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" data-keyboard-nav-preserve>
      <div className="bg-card text-card-foreground rounded-xl shadow-2xl w-full max-w-6xl max-h-[94vh] overflow-hidden flex flex-col"
        role="dialog" aria-modal="true" aria-labelledby="subnet-scan-title">

        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Icon name="radar" className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 id="subnet-scan-title" className="text-lg font-semibold leading-tight">Add Device</h3>
              <p className="text-sm text-muted-foreground truncate">Scan a range of addresses and add the cameras you find.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="inline-flex rounded-lg bg-muted p-1 text-sm" role="tablist" aria-label="Add device method">
              <button type="button" role="tab" aria-selected="false"
                className="px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                onClick={onSwitchToKnownAddress} disabled={scanning || connecting}>
                Known Address
              </button>
              <button type="button" role="tab" aria-selected="true"
                className="px-3 py-1.5 rounded-md bg-background text-foreground font-medium shadow-sm">
                Subnet Scan
              </button>
            </div>
            <button type="button" className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
              onClick={onClose} aria-label="Close">
              <Icon name="x" className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Scan settings */}
        <form className="px-6 py-5 border-b border-border bg-muted/20" onSubmit={startScan}>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-6 gap-y-4">
            <fieldset className="lg:col-span-5 min-w-0">
              <legend className={`${sectionLabelClass} mb-2`}>Network range</legend>
              <div className="flex items-center gap-2">
                <div className="flex-1 min-w-0">
                  <label className="sr-only" htmlFor="subnet-start-ip">Start IP</label>
                  <input id="subnet-start-ip" className={`${inputClass} font-mono`} placeholder="172.16.3.1" value={startIp}
                    disabled={scanning} onInput={(event) => setStartIp(event.currentTarget.value)} />
                </div>
                <span className="text-muted-foreground text-sm" aria-hidden="true">to</span>
                <div className="flex-1 min-w-0">
                  <label className="sr-only" htmlFor="subnet-end-ip">End IP</label>
                  <input id="subnet-end-ip" className={`${inputClass} font-mono`} placeholder="172.16.3.255" value={endIp}
                    disabled={scanning} onInput={(event) => setEndIp(event.currentTarget.value)} />
                </div>
              </div>
              <p className={`mt-1.5 text-xs ${rangeError ? 'text-destructive' : 'text-muted-foreground'}`} data-testid="subnet-range-hint">
                {rangeError || rangeHint}
              </p>
            </fieldset>

            <fieldset className="lg:col-span-5 min-w-0">
              <legend className={`${sectionLabelClass} mb-2`}>Credentials</legend>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="sr-only" htmlFor="subnet-username">Username</label>
                  <input id="subnet-username" className={inputClass} placeholder="Username" autoComplete="off" value={username}
                    disabled={scanning} onInput={(event) => setUsername(event.currentTarget.value)} />
                </div>
                <div>
                  <label className="sr-only" htmlFor="subnet-password">Password</label>
                  <PasswordInput id="subnet-password" value={password} disabled={scanning}
                    onInput={(event) => setPassword(event.currentTarget.value)} />
                </div>
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground flex items-center gap-1">
                <Icon name="shield" className="w-3.5 h-3.5" /> Tried on every camera found; used only for this scan, never stored.
              </p>
            </fieldset>

            <fieldset className="lg:col-span-2 min-w-0">
              <legend className={`${sectionLabelClass} mb-2`}>RTSP port</legend>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-sm whitespace-nowrap cursor-pointer select-none">
                  <input type="checkbox" className="h-4 w-4 rounded border-input" checked={useDefaultPort} disabled={scanning}
                    onChange={(event) => setUseDefaultPort(event.currentTarget.checked)} />
                  Default
                </label>
                <label className="sr-only" htmlFor="subnet-port">RTSP port</label>
                <input id="subnet-port" className={`${inputClass} font-mono`} inputMode="numeric"
                  value={useDefaultPort ? String(DEFAULT_RTSP_PORT) : customPort}
                  disabled={scanning || useDefaultPort} onInput={(event) => setCustomPort(event.currentTarget.value)} />
              </div>
            </fieldset>
          </div>

          <div className="mt-5 flex flex-col sm:flex-row sm:items-center gap-3">
            {scanning ? (
              <button type="button" className="btn-secondary inline-flex items-center justify-center gap-2" onClick={cancelScan}>
                <Icon name="stop" /> Cancel Scan
              </button>
            ) : (
              <button type="submit" id="subnet-scan-btn" className="btn-primary inline-flex items-center justify-center gap-2 min-w-[8rem] disabled:opacity-50 disabled:cursor-not-allowed" disabled={connecting}>
                <Icon name="search" /> Scan
              </button>
            )}
            {formError ? (
              <p className="text-sm text-destructive" role="alert">{formError}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Finds ONVIF and RTSP cameras in the range and checks the credentials on each.</p>
            )}
          </div>
        </form>

        {/* Progress, results and states */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4" aria-live="polite">
          {scanning && (
            <div className="rounded-lg border border-border p-4" data-testid="subnet-scan-progress">
              <div className="flex items-center justify-between gap-3 text-sm">
                <div className="flex items-center gap-2 font-medium">
                  <Spinner className="w-4 h-4 text-primary" />
                  Scanning <span className="font-mono font-normal">{scan.startIp} – {scan.endIp}</span>
                </div>
                <span className="tabular-nums font-semibold">{percent}%</span>
              </div>
              <div className="mt-3 h-2 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${percent}%` }} />
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
                <span className={`flex items-center gap-1.5 ${probingDone ? '' : 'text-foreground font-medium'}`}>
                  {probingDone ? <Icon name="check" className="w-3.5 h-3.5 text-green-600" /> : <span className="w-1.5 h-1.5 rounded-full bg-primary" />}
                  1. Discover devices · {scan.scannedHosts}/{scan.totalHosts} addresses
                </span>
                <span className={`flex items-center gap-1.5 ${probingDone ? 'text-foreground font-medium' : ''}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${probingDone ? 'bg-primary' : 'bg-muted-foreground/40'}`} />
                  2. Verify credentials · {scan.processed}/{scan.candidates}
                </span>
                <span className="ml-auto tabular-nums">{scan.candidates} device{scan.candidates === 1 ? '' : 's'} found</span>
              </div>
            </div>
          )}

          {scan?.error && <Banner tone="error" icon="alert">Scan error: {scan.error}</Banner>}
          {scan?.cancelled && !scanning && (
            <Banner tone="warning" icon="info">Scan cancelled. Devices found before cancelling are listed below.</Banner>
          )}

          {!scan?.scanId && !scanning && (
            <div className="flex flex-col items-center justify-center text-center py-14" data-testid="subnet-scan-empty">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground mb-4">
                <Icon name="radar" className="w-7 h-7" />
              </div>
              <p className="font-medium">No devices found yet</p>
              <p className="text-sm text-muted-foreground mt-1">Enter an IP range and click Scan.</p>
            </div>
          )}
          {scan?.completed && devices.length === 0 && !scan.cancelled && !scan.error && (
            <div className="flex flex-col items-center justify-center text-center py-14">
              <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-muted-foreground mb-4">
                <Icon name="search" className="w-7 h-7" />
              </div>
              <p className="font-medium">No cameras were discovered in this IP range.</p>
              <p className="text-sm text-muted-foreground mt-1">Check the range, and that the cameras are powered on and reachable from this server.</p>
            </div>
          )}

          {devices.length > 0 && (
            <section>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h4 className="text-sm font-semibold mr-1" data-testid="subnet-scan-summary">
                    {foundCount} device{foundCount === 1 ? '' : 's'} found, {scan?.newCount ?? 0} new
                  </h4>
                  {addedCount > 0 && <span className={`${pillBase} ${NEUTRAL_PILL}`}>{addedCount} already added</span>}
                  {attentionCount > 0 && <span className={`${pillBase} ${STATUS_STYLE['Credentials Failed']}`}>{attentionCount} need attention</span>}
                </div>
              </div>

              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="min-w-full text-sm" data-testid="subnet-scan-results">
                  <thead className="bg-muted/50">
                    <tr className="text-left text-xs font-medium uppercase tracking-wider text-muted-foreground">
                      <th className="w-10 px-4 py-3">
                        <input type="checkbox" className="h-4 w-4 rounded border-input" aria-label="Select all" checked={allSelected}
                          disabled={selectableDevices.length === 0 || connecting || scanning} onChange={toggleAll} />
                      </th>
                      <th className="px-4 py-3">Device</th>
                      <th className="px-4 py-3">Type</th>
                      <th className="px-4 py-3">Address</th>
                      <th className="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {devices.map((device) => {
                      const connection = connections[device.ip];
                      const selectable = isDeviceSelectable(device, connection);
                      const isSelected = selectable && selected.has(device.ip);
                      const label = deviceStatusLabel(device, connection);
                      const detail = connection?.state === 'connected'
                        ? `Added as ${connection.name}`
                        : connection?.message || (device.alreadyAdded ? `Added as ${device.alreadyAddedAs}` : device.message);
                      const brandKnown = device.brand && device.brand !== 'Unknown';
                      const modelKnown = device.model && device.model !== 'Unknown';
                      return (
                        <tr key={device.ip} data-ip={device.ip}
                          className={`transition-colors ${isSelected ? 'bg-primary/5' : 'hover:bg-muted/30'} ${!selectable && !connection ? 'text-muted-foreground' : ''}`}>
                          <td className="px-4 py-3 align-top">
                            <input type="checkbox" className="h-4 w-4 rounded border-input" aria-label={`Select ${device.ip}`} checked={isSelected}
                              disabled={!selectable || connecting || scanning} onChange={() => toggleOne(device.ip)} />
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className={`font-medium ${brandKnown ? 'text-foreground' : 'text-muted-foreground'}`}>{brandKnown ? device.brand : 'Unknown brand'}</div>
                            <div className="text-xs text-muted-foreground">{modelKnown ? device.model : 'Model not reported'}</div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <span className={`${pillBase} ${device.protocol === 'onvif' ? 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400' : NEUTRAL_PILL}`}>
                              {device.protocol === 'onvif' ? 'ONVIF' : 'RTSP'}
                            </span>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <div className="font-mono text-foreground">{device.ip}</div>
                            <div className="text-xs text-muted-foreground">Port {devicePortLabel(device)}</div>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <StatusPill label={label} />
                            {detail && <p className="mt-1 text-xs text-muted-foreground max-w-sm leading-snug">{detail}</p>}
                            {device.authStatus === 'credentials_failed' && !device.alreadyAdded && !connection && !scanning && (
                              <button type="button" disabled={connecting} onClick={() => retryRowCredentials(device)}
                                className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors disabled:opacity-50">
                                <Icon name="key" className="w-3.5 h-3.5" /> Enter credentials
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {connectionSummary.length > 0 && !connecting && (
            <section className="rounded-lg border border-border" data-testid="subnet-connect-summary">
              <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-border bg-muted/30">
                <h4 className="text-sm font-semibold mr-1">Connection results</h4>
                <span className={`${pillBase} ${STATUS_STYLE.Connected}`}>{connectedCount} connected</span>
                {connectionSummary.length - connectedCount > 0 && (
                  <span className={`${pillBase} ${STATUS_STYLE['Connection failed']}`}>{connectionSummary.length - connectedCount} failed</span>
                )}
              </div>
              <ul className="divide-y divide-border text-sm">
                {connectionSummary.map(([ip, result]) => (
                  <li key={ip} className="flex items-center gap-3 px-4 py-2">
                    <span className={result.state === 'connected' ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
                      <Icon name={result.state === 'connected' ? 'check' : 'x'} />
                    </span>
                    <span className="font-mono w-32 flex-shrink-0">{ip}</span>
                    <span className="text-muted-foreground">{result.state === 'connected' ? `Connected as ${result.name}` : result.message}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-border bg-muted/20">
          <p className="text-sm text-muted-foreground">
            {connecting ? 'Connecting cameras…' : devices.length > 0 ? `${selectedCount} of ${selectableDevices.length} selected` : ''}
          </p>
          <div className="flex items-center gap-3">
            <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
            <button type="button" id="subnet-connect-btn" className="btn-primary inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
              disabled={selectedCount === 0 || connecting || scanning} onClick={connectSelected}>
              {connecting ? <Spinner /> : <Icon name="plug" />}
              {connecting ? 'Connecting…' : `Connect Selected${selectedCount ? ` (${selectedCount})` : ''}`}
            </button>
          </div>
        </div>
      </div>

      <CredentialDialog
        request={credentialRequest}
        onSubmit={(value) => finishCredentialRequest(value)}
        onCancel={() => finishCredentialRequest(null)}
      />
    </div>
  );
}
