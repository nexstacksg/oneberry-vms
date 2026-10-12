/**
 * Camera Discovery: connect several discovered ONVIF cameras that share one
 * username/password. Network calls are passed in so this stays testable.
 */

import { buildDiscoveredStreamPayload } from './discovered-stream-utils.js';
import { makeCameraName } from './subnet-scan-utils.js';

const pixels = (profile) => (Number(profile.width) || 0) * (Number(profile.height) || 0);

/**
 * Main stream = the largest profile; sub stream = the smallest other profile
 * with a different stream URL (if any).
 * @param {Object[]} profiles  ONVIF profiles ({token, name, stream_uri, width, height})
 * @returns {{main: Object|null, sub: Object|null}}
 */
export function pickStreamProfiles(profiles) {
  const usable = (Array.isArray(profiles) ? profiles : []).filter((profile) => profile?.stream_uri);
  if (usable.length === 0) return { main: null, sub: null };
  const main = usable.reduce((best, profile) => (pixels(profile) > pixels(best) ? profile : best));
  const others = usable.filter((profile) => profile !== main && profile.stream_uri !== main.stream_uri);
  const sub = others.length ? others.reduce((best, profile) => (pixels(profile) < pixels(best) ? profile : best)) : null;
  return { main, sub };
}

/**
 * Connect the given discovered devices one after another with shared
 * credentials; one failure never stops the rest.
 *
 * @param {Object[]} devices  discovered devices ({ip_address, manufacturer, model, onvif, device_service})
 * @param {Object} options
 * @param {{username: string, password: string}} options.credentials
 * @param {string[]} options.existingNames   current camera names
 * @param {Function} options.fetchProfiles   (device, credentials) => Promise<profile[]>; throws with a message
 * @param {Function} options.createStream    (payload) => Promise; throws on failure
 * @param {Function} [options.onUpdate]      (ip, {state, message, name}) progress callback
 * @returns {Promise<Object<string, {state: string, message: string, name?: string}>>}
 */
export async function connectDiscoveredDevices(devices, {
  credentials,
  existingNames = [],
  fetchProfiles,
  createStream,
  onUpdate = () => {},
}) {
  const results = {};
  const takenNames = new Set(existingNames.map((name) => String(name).toLowerCase()));
  const report = (ip, state, message = '', extra = {}) => {
    results[ip] = { state, message, ...extra };
    onUpdate(ip, results[ip]);
  };

  for (const device of devices) {
    const ip = device.ip_address;
    report(ip, 'connecting');

    if (!device.onvif) {
      report(ip, 'failed', 'Not an ONVIF camera; add it with Subnet Scan or Known Address');
      continue;
    }

    let profiles;
    try {
      profiles = await fetchProfiles(device, credentials);
    } catch (error) {
      report(ip, 'failed', error.message || 'Could not read the camera streams');
      continue;
    }

    const { main, sub } = pickStreamProfiles(profiles);
    if (!main) {
      report(ip, 'failed', 'The camera did not return any video streams');
      continue;
    }

    const name = makeCameraName({ brand: device.manufacturer, ip }, takenNames);
    const payload = buildDiscoveredStreamPayload({
      name,
      streamUrl: main.stream_uri,
      secondaryUrl: sub?.stream_uri || '',
      username: credentials.username,
      password: credentials.password,
      isOnvif: true,
      onvifProfile: main.token || main.name || '',
      width: Number(main.width) || 0,
      height: Number(main.height) || 0,
    });

    try {
      await createStream(payload);
      report(ip, 'connected', '', { name });
    } catch (error) {
      report(ip, 'failed', error.message || 'Could not add the camera');
    }
  }
  return results;
}
