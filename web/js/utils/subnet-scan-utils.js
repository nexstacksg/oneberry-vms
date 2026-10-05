/**
 * Subnet Scan helpers: IP range validation, result statuses, camera naming
 * and the "Connect Selected" sequence. Network calls are passed in so this
 * module stays testable.
 */

import { buildDiscoveredStreamPayload } from './discovered-stream-utils.js';

/** Must match IP_RANGE_MAX_HOSTS on the server */
export const SUBNET_SCAN_MAX_HOSTS = 1024;
export const DEFAULT_RTSP_PORT = 554;

/**
 * Parse dotted-quad IPv4 to an unsigned 32-bit number, or null if invalid.
 * @param {string} text
 * @returns {number|null}
 */
export function ipToNumber(text) {
  const parts = String(text || '').trim().split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/** Private LAN ranges the server allows (10/8, 172.16/12, 192.168/16, 169.254/16) */
export function isPrivateLanIp(value) {
  return (value >= 0x0A000000 && value <= 0x0AFFFFFF) ||
    (value >= 0xAC100000 && value <= 0xAC1FFFFF) ||
    (value >= 0xC0A80000 && value <= 0xC0A8FFFF) ||
    (value >= 0xA9FE0000 && value <= 0xA9FEFFFF);
}

/**
 * Validate a start/end range the same way the server does, for instant
 * feedback. The server re-checks everything.
 * @returns {{ valid: boolean, error?: string, hostCount?: number }}
 */
export function validateIpRange(startIp, endIp) {
  const start = ipToNumber(startIp);
  if (start === null) return { valid: false, error: 'Start IP is not a valid IPv4 address' };
  const end = ipToNumber(endIp);
  if (end === null) return { valid: false, error: 'End IP is not a valid IPv4 address' };
  if (start > end) return { valid: false, error: 'Start IP must not be greater than End IP' };
  const hostCount = end - start + 1;
  if (hostCount > SUBNET_SCAN_MAX_HOSTS) {
    return { valid: false, error: `The range is too large (at most ${SUBNET_SCAN_MAX_HOSTS} addresses)` };
  }
  if (!isPrivateLanIp(start) || !isPrivateLanIp(end)) {
    return { valid: false, error: 'Only private LAN addresses can be scanned (10.x, 172.16-31.x, 192.168.x, 169.254.x)' };
  }
  return { valid: true, hostCount };
}

/** Validate a custom RTSP port; '' or null means the default */
export function validatePort(value) {
  if (value === '' || value === null || value === undefined) return { valid: true, port: DEFAULT_RTSP_PORT };
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { valid: false, error: 'Port must be a whole number between 1 and 65535' };
  }
  return { valid: true, port };
}

/**
 * What the row status column shows for a device.
 * Connection results (connecting/connected/failed) take precedence.
 */
export function deviceStatusLabel(device, connection) {
  if (connection?.state === 'connecting') return 'Connecting…';
  if (connection?.state === 'connected') return 'Connected';
  if (connection?.state === 'failed') return 'Connection failed';
  if (device.alreadyAdded) return 'Already Added';
  switch (device.authStatus) {
    case 'ready': return 'Ready';
    case 'credentials_failed': return 'Credentials Failed';
    case 'needs_rtsp_path': return 'Needs RTSP path';
    case 'busy': return 'Camera busy';
    case 'error': return 'Error';
    default: return 'Checking…';
  }
}

/**
 * Whether a device can be selected for "Connect Selected". Devices whose
 * credentials failed can be selected: the user is asked for credentials.
 */
export function isDeviceSelectable(device, connection) {
  if (device.alreadyAdded || connection?.state === 'connected' || connection?.state === 'connecting') {
    return false;
  }
  return device.authStatus === 'ready' || device.authStatus === 'credentials_failed';
}

/** Ports column, e.g. "80/554" for ONVIF, "554" for RTSP */
export function devicePortLabel(device) {
  return device.protocol === 'onvif' && device.onvifPort
    ? `${device.onvifPort}/${device.rtspPort}`
    : String(device.rtspPort || '');
}

/**
 * A camera name that is not used yet, e.g. "hikvision-172-16-3-201".
 * @param {Object} device
 * @param {Set<string>} takenNames  existing camera names (lower case); updated
 */
export function makeCameraName(device, takenNames) {
  const brand = String(device.brand || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const base = `${brand && brand !== 'unknown' ? brand : 'camera'}-${String(device.ip).replace(/\./g, '-')}`;
  let name = base;
  for (let n = 2; takenNames.has(name.toLowerCase()); n++) {
    name = `${base}-${n}`;
  }
  takenNames.add(name.toLowerCase());
  return name;
}

/**
 * Connect the selected devices one after another, so one failure never stops
 * the rest.
 *
 * @param {Object[]} devices         selected scan results
 * @param {Object} options
 * @param {{username: string, password: string}} options.commonCredentials
 * @param {Object<string, {username: string, password: string}>} [options.deviceCredentials]
 *        credentials already confirmed for specific cameras (by IP); used instead of the common ones
 * @param {string[]} options.existingNames   current camera names
 * @param {Function} options.authenticate     (ip, {username, password}) => Promise<device>
 * @param {Function} options.createStream     (payload) => Promise<any>; throws on failure
 * @param {Function} options.requestCredentials (device, errorMessage) =>
 *        Promise<{username, password, applyToOthers}|null>; null = skip this camera
 * @param {Function} [options.onUpdate]       (ip, {state, message, device}) progress callback
 * @returns {Promise<Object<string, {state: string, message: string, name?: string}>>}
 */
export async function connectSelectedDevices(devices, {
  commonCredentials,
  deviceCredentials = {},
  existingNames = [],
  authenticate,
  createStream,
  requestCredentials,
  onUpdate = () => {},
}) {
  const results = {};
  const takenNames = new Set(existingNames.map(name => String(name).toLowerCase()));
  let sharedCredentials = null; // "use these credentials for other failed cameras"

  const report = (ip, state, message = '', extra = {}) => {
    results[ip] = { state, message, ...extra };
    onUpdate(ip, results[ip]);
  };

  for (const original of devices) {
    let device = original;
    let credentials = deviceCredentials[device.ip] || commonCredentials;
    report(device.ip, 'connecting');

    if (device.alreadyAdded) {
      report(device.ip, 'skipped', 'Already added');
      continue;
    }

    // Credentials failed during the scan: try shared ones, then ask the user
    if (device.authStatus === 'credentials_failed') {
      let lastError = device.message || 'The common username and password did not work for this camera';
      let resolved = false;

      if (sharedCredentials) {
        try {
          const retried = await authenticate(device.ip, sharedCredentials);
          if (retried.authStatus === 'ready') {
            device = retried;
            credentials = sharedCredentials;
            resolved = true;
          } else {
            lastError = retried.message || lastError;
          }
        } catch (error) {
          lastError = error.message;
        }
      }

      while (!resolved) {
        const entered = await requestCredentials(device, lastError);
        if (!entered) {
          break;
        }
        const tryCredentials = { username: entered.username, password: entered.password };
        try {
          const retried = await authenticate(device.ip, tryCredentials);
          if (retried.authStatus === 'ready') {
            device = retried;
            credentials = tryCredentials;
            if (entered.applyToOthers) sharedCredentials = tryCredentials;
            resolved = true;
          } else {
            lastError = retried.message || 'Authentication failed';
          }
        } catch (error) {
          lastError = error.message || 'Authentication failed';
        }
      }

      if (!resolved) {
        report(device.ip, 'failed', 'Authentication failed', { device });
        continue;
      }
    }

    if (device.authStatus !== 'ready' || !device.streamUrl) {
      report(device.ip, 'failed', device.message || 'No working video stream was found for this camera', { device });
      continue;
    }

    const name = makeCameraName(device, takenNames);
    const payload = buildDiscoveredStreamPayload({
      name,
      streamUrl: device.streamUrl,
      secondaryUrl: device.subStreamUrl || '',
      username: credentials?.username || '',
      password: credentials?.password || '',
      isOnvif: device.protocol === 'onvif' && device.onvifLogin === true,
      onvifProfile: device.profileToken || '',
      width: device.width || 0,
      height: device.height || 0,
    });

    try {
      await createStream(payload);
      report(device.ip, 'connected', '', { name, device });
    } catch (error) {
      report(device.ip, 'failed', error.message || 'Could not add the camera', { device });
    }
  }

  return results;
}
