/**
 * Turning a discovered device (ONVIF profile or RTSP stream) into a camera.
 * Shared by the Camera Discovery flow and Subnet Scan so both create cameras
 * with the same settings through POST /api/streams.
 */

/**
 * Put username/password into a stream URL (replacing any already there).
 * @param {string} url
 * @param {string} username
 * @param {string} password
 * @returns {string}
 */
export function applyCredentialsToStreamUrl(url, username, password) {
  const rawUrl = String(url || '').trim();
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!rawUrl || (!user && !pass)) {
    return rawUrl;
  }

  try {
    const parsed = new URL(rawUrl);
    if (user) parsed.username = user;
    if (pass) parsed.password = pass;
    return parsed.toString();
  } catch {
    const protocolMatch = rawUrl.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
    if (!protocolMatch) return rawUrl;
    const credential = `${encodeURIComponent(user)}${pass ? `:${encodeURIComponent(pass)}` : ''}@`;
    const withoutExistingCredentials = protocolMatch[2].replace(/^[^/@]+@/, '');
    return `${protocolMatch[1]}${credential}${withoutExistingCredentials}`;
  }
}

/**
 * Camera settings for POST /api/streams from a discovered device.
 *
 * @param {Object} options
 * @param {string} options.name            camera name
 * @param {string} options.streamUrl       main stream URL (without credentials)
 * @param {string} [options.secondaryUrl]  sub stream URL (without credentials)
 * @param {string} [options.username]
 * @param {string} [options.password]
 * @param {boolean} [options.isOnvif]      ONVIF login works for this camera
 * @param {string} [options.onvifProfile]  ONVIF profile token
 * @param {number} [options.width]         0 = auto-detect
 * @param {number} [options.height]        0 = auto-detect
 * @param {number} [options.fps]           0 = auto-detect
 * @returns {Object}
 */
export function buildDiscoveredStreamPayload({
  name,
  streamUrl,
  secondaryUrl = '',
  username = '',
  password = '',
  isOnvif = false,
  onvifProfile = '',
  width = 0,
  height = 0,
  fps = 0,
}) {
  return {
    name: String(name || '').trim(),
    // ONVIF profiles expose the media endpoint as `stream_uri`, while our
    // backend `Stream` model expects this value under the generic `url` field.
    url: applyCredentialsToStreamUrl(streamUrl, username, password),
    secondary_url: secondaryUrl ? applyCredentialsToStreamUrl(secondaryUrl, username, password) : '',
    enabled: true,
    streaming_enabled: true,
    width,
    height,
    fps,
    protocol: '0', // TCP
    priority: '5', // Medium
    segment_duration: 60,
    record: true,
    record_audio: false,
    backchannel_enabled: false,
    retention_days: 1,
    detection_retention_days: 1,
    // Backend expects camelCase key 'isOnvif'
    isOnvif: !!isOnvif,
    onvif_username: isOnvif ? username : '',
    onvif_password: isOnvif ? password : '',
    onvif_profile: isOnvif ? onvifProfile : '',
    onvif_port: 0,
  };
}
