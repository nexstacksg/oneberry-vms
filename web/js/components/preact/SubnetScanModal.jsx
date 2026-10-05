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

const inputClass = 'w-full px-3 py-2 border border-input rounded-md shadow-sm bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-60';

const statusTone = (label) => {
  if (label === 'Ready' || label === 'Connected') return 'text-green-600 dark:text-green-400';
  if (label === 'Already Added' || label === 'Checking…' || label === 'Connecting…') return 'text-muted-foreground';
  if (label === 'Credentials Failed' || label === 'Needs RTSP path' || label === 'Camera busy') return 'text-amber-600 dark:text-amber-400';
  return 'text-destructive';
};

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

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    await onSubmit({ username: username.trim(), password, applyToOthers });
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[60] p-4" data-keyboard-nav-preserve>
      <form
        className="bg-card text-card-foreground rounded-lg shadow-xl w-full max-w-md p-6"
        role="dialog"
        aria-modal="true"
        aria-labelledby="subnet-credential-title"
        onSubmit={submit}
      >
        <h3 id="subnet-credential-title" className="text-lg font-semibold mb-1">Connect Camera</h3>
        <p className="text-sm text-muted-foreground mb-4">
          Camera: <span className="font-mono text-foreground">{device.ip}</span>
          {device.brand && device.brand !== 'Unknown' ? ` (${device.brand}${device.model && device.model !== 'Unknown' ? ` ${device.model}` : ''})` : ''}
        </p>
        {error && (
          <p className="text-sm text-destructive mb-4" role="alert">{error}</p>
        )}
        <label className="block text-sm font-medium mb-1" htmlFor="subnet-credential-username">Username</label>
        <input
          id="subnet-credential-username"
          className={`${inputClass} mb-3`}
          value={username}
          autoFocus
          autoComplete="off"
          onInput={(event) => setUsername(event.currentTarget.value)}
        />
        <label className="block text-sm font-medium mb-1" htmlFor="subnet-credential-password">Password</label>
        <input
          id="subnet-credential-password"
          type="password"
          className={`${inputClass} mb-3`}
          value={password}
          autoComplete="new-password"
          onInput={(event) => setPassword(event.currentTarget.value)}
        />
        {showApplyToOthers && (
          <label className="flex items-center gap-2 text-sm mb-1 cursor-pointer">
            <input type="checkbox" checked={applyToOthers} onChange={(event) => setApplyToOthers(event.currentTarget.checked)} />
            Use these credentials for other failed cameras
          </label>
        )}
        <div className="flex justify-end gap-3 mt-5">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={busy || !username}>
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
  const selectedCount = devices.filter((device) => selected.has(device.ip)).length;

  return (
    <div className="content-modal-backdrop fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" data-keyboard-nav-preserve>
      <div className="bg-card text-card-foreground rounded-lg shadow-xl w-full max-w-5xl max-h-[94vh] overflow-hidden flex flex-col" role="dialog" aria-modal="true" aria-labelledby="subnet-scan-title">
        <div className="flex items-start justify-between gap-4 p-5 border-b border-border">
          <div>
            <h3 id="subnet-scan-title" className="text-lg font-semibold">Add Device</h3>
            <div className="mt-3 inline-flex rounded-md border border-border p-0.5 text-sm" role="tablist">
              <button type="button" role="tab" aria-selected="false" className="px-3 py-1 rounded text-muted-foreground hover:text-foreground"
                onClick={onSwitchToKnownAddress} disabled={scanning || connecting}>
                Known Address
              </button>
              <button type="button" role="tab" aria-selected="true" className="px-3 py-1 rounded bg-primary text-primary-foreground">
                Subnet Scan
              </button>
            </div>
          </div>
          <button type="button" className="text-2xl leading-none text-muted-foreground hover:text-foreground" onClick={onClose} aria-label="Close">×</button>
        </div>

        <form className="p-5 border-b border-border bg-muted/20" onSubmit={startScan}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="subnet-start-ip">Start IP</label>
              <input id="subnet-start-ip" className={inputClass} placeholder="172.16.3.1" value={startIp}
                disabled={scanning} onInput={(event) => setStartIp(event.currentTarget.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="subnet-end-ip">End IP</label>
              <input id="subnet-end-ip" className={inputClass} placeholder="172.16.3.255" value={endIp}
                disabled={scanning} onInput={(event) => setEndIp(event.currentTarget.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="subnet-username">Username</label>
              <input id="subnet-username" className={inputClass} autoComplete="off" value={username}
                disabled={scanning} onInput={(event) => setUsername(event.currentTarget.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="subnet-password">Password</label>
              <input id="subnet-password" type="password" className={inputClass} autoComplete="new-password" value={password}
                disabled={scanning} onInput={(event) => setPassword(event.currentTarget.value)} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1" htmlFor="subnet-port">RTSP port</label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-sm whitespace-nowrap cursor-pointer">
                  <input type="checkbox" checked={useDefaultPort} disabled={scanning}
                    onChange={(event) => setUseDefaultPort(event.currentTarget.checked)} />
                  Default
                </label>
                <input id="subnet-port" className={inputClass} inputMode="numeric"
                  value={useDefaultPort ? String(DEFAULT_RTSP_PORT) : customPort}
                  disabled={scanning || useDefaultPort} onInput={(event) => setCustomPort(event.currentTarget.value)} />
              </div>
            </div>
          </div>
          <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-3">
            {scanning ? (
              <button type="button" className="btn-secondary" onClick={cancelScan}>Cancel Scan</button>
            ) : (
              <button type="submit" id="subnet-scan-btn" className="btn-primary" disabled={connecting}>Scan</button>
            )}
            {formError ? (
              <p className="text-sm text-destructive" role="alert">{formError}</p>
            ) : (startIp && endIp && !rangeCheck.valid) ? (
              <p className="text-sm text-destructive">{rangeCheck.error}</p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Finds ONVIF cameras and RTSP cameras in the range, and tries this username and password on each.
              </p>
            )}
          </div>
        </form>

        <div className="flex-1 overflow-y-auto p-5" aria-live="polite">
          {scanning && (
            <div className="mb-5" data-testid="subnet-scan-progress">
              <div className="flex justify-between text-sm mb-1">
                <span>Scanning {scan.startIp} – {scan.endIp}</span>
                <span>{percent}%</span>
              </div>
              <div className="h-2 rounded bg-muted overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${percent}%` }} />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {scan.phase === 'probing'
                  ? `Checking addresses ${scan.scannedHosts}/${scan.totalHosts}`
                  : `Checking credentials ${scan.processed}/${scan.candidates}`}
                {' · '}Found: {scan.candidates} device{scan.candidates === 1 ? '' : 's'}
              </p>
            </div>
          )}

          {scan?.error && <p className="text-sm text-destructive mb-4" role="alert">Scan error: {scan.error}</p>}
          {scan?.cancelled && !scanning && (
            <p className="text-sm text-amber-600 dark:text-amber-400 mb-4">Scan cancelled. Results found before cancelling are shown below.</p>
          )}

          {!scan?.scanId && !scanning && (
            <div className="text-center text-muted-foreground py-10" data-testid="subnet-scan-empty">
              No devices found yet.<br />Enter an IP range and click Scan.
            </div>
          )}
          {scan?.completed && devices.length === 0 && !scan.cancelled && !scan.error && (
            <div className="text-center text-muted-foreground py-10">No cameras were discovered in this IP range.</div>
          )}

          {devices.length > 0 && (
            <>
              <p className="text-sm font-medium mb-2" data-testid="subnet-scan-summary">
                {scan?.foundCount ?? devices.length} device{(scan?.foundCount ?? devices.length) === 1 ? '' : 's'} found, {scan?.newCount ?? 0} new
              </p>
              <div className="overflow-x-auto border border-border rounded-md">
                <table className="min-w-full text-sm" data-testid="subnet-scan-results">
                  <thead className="bg-muted/40 text-left">
                    <tr>
                      <th className="px-3 py-2 w-8">
                        <input type="checkbox" aria-label="Select all" checked={allSelected}
                          disabled={selectableDevices.length === 0 || connecting || scanning} onChange={toggleAll} />
                      </th>
                      <th className="px-3 py-2">Brand</th>
                      <th className="px-3 py-2">Model</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2">Address</th>
                      <th className="px-3 py-2">Port</th>
                      <th className="px-3 py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.map((device) => {
                      const connection = connections[device.ip];
                      const selectable = isDeviceSelectable(device, connection);
                      const label = deviceStatusLabel(device, connection);
                      const detail = connection?.state === 'connected'
                        ? `Added as ${connection.name}`
                        : connection?.message || (device.alreadyAdded ? `Added as ${device.alreadyAddedAs}` : device.message);
                      return (
                        <tr key={device.ip} className="border-t border-border" data-ip={device.ip}>
                          <td className="px-3 py-2 align-top">
                            <input type="checkbox" aria-label={`Select ${device.ip}`} checked={selectable && selected.has(device.ip)}
                              disabled={!selectable || connecting || scanning} onChange={() => toggleOne(device.ip)} />
                          </td>
                          <td className="px-3 py-2 align-top">{device.brand}</td>
                          <td className="px-3 py-2 align-top">{device.model}</td>
                          <td className="px-3 py-2 align-top">{device.protocol === 'onvif' ? 'ONVIF' : 'RTSP'}</td>
                          <td className="px-3 py-2 align-top font-mono">{device.ip}</td>
                          <td className="px-3 py-2 align-top">{devicePortLabel(device)}</td>
                          <td className="px-3 py-2 align-top">
                            <span className={`font-medium ${statusTone(label)}`} data-testid="subnet-scan-status">
                              {label === 'Connected' ? '✓ ' : label === 'Connection failed' ? '✗ ' : ''}{label}
                            </span>
                            {detail && <div className="text-xs text-muted-foreground max-w-xs">{detail}</div>}
                            {device.authStatus === 'credentials_failed' && !device.alreadyAdded && !connection && !scanning && (
                              <button type="button" className="text-xs text-primary hover:underline mt-1" disabled={connecting}
                                onClick={() => retryRowCredentials(device)}>
                                Enter credentials
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {connectionSummary.length > 0 && !connecting && (
            <div className="mt-4 text-sm" data-testid="subnet-connect-summary">
              <p className="font-medium mb-1">{connectionSummary.length} selected</p>
              <ul className="space-y-0.5">
                {connectionSummary.map(([ip, result]) => (
                  <li key={ip} className={result.state === 'connected' ? 'text-green-600 dark:text-green-400' : 'text-destructive'}>
                    {result.state === 'connected' ? '✓' : '✗'} {ip} {result.state === 'connected' ? `Connected as ${result.name}` : result.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-border">
          <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
          <button type="button" id="subnet-connect-btn" className="btn-primary"
            disabled={selectedCount === 0 || connecting || scanning} onClick={connectSelected}>
            {connecting ? 'Connecting…' : `Connect Selected${selectedCount ? ` (${selectedCount})` : ''}`}
          </button>
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
