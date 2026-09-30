/**
 * Helpers for auto-detecting a camera's resolution, frame rate and codec
 * from its stream URL (via POST /api/streams/test).
 */

// rtsp://[user[:pass]@]host[:port][/path] — host must be present and non-empty
const PROBEABLE_URL_RE = /^rtsps?:\/\/(?:[^@/\s]+@)?[^@/:\s]+(?::\d{1,5})?(?:\/\S*)?$/i;

/**
 * Whether a URL is complete enough to be worth probing.
 * @param {string} url
 * @returns {boolean}
 */
export function isProbeableStreamUrl(url) {
  return typeof url === 'string' && PROBEABLE_URL_RE.test(url.trim());
}

/**
 * Map an FFmpeg decoder name to a codec option value used by the form.
 * @param {string} name - e.g. "h264", "hevc", "mjpeg"
 * @returns {string|null} - "h264", "h265", "mjpeg", or null if not one of the form's options
 */
export function normalizeDetectedCodec(name) {
  const codec = String(name || '').toLowerCase();
  if (codec === 'h264') return 'h264';
  if (codec === 'hevc' || codec === 'h265') return 'h265';
  if (codec === 'mjpeg') return 'mjpeg';
  return null;
}

/**
 * Turn the probe's `info` object into form fields. Only values the probe
 * actually detected are returned, so unknown values never overwrite the form.
 * @param {{width?: number, height?: number, fps?: number, codec?: string}} info
 * @returns {{width?: number, height?: number, fps?: number, codec?: string}}
 */
export function detectedInfoToFormFields(info) {
  const fields = {};
  const width = Number(info?.width) || 0;
  const height = Number(info?.height) || 0;
  const fps = Math.round(Number(info?.fps) || 0);
  const codec = normalizeDetectedCodec(info?.codec);

  if (width > 0 && height > 0) {
    fields.width = width;
    fields.height = height;
  }
  if (fps > 0) {
    fields.fps = fps;
  }
  if (codec) {
    fields.codec = codec;
  }
  return fields;
}

/**
 * Short human-readable summary, e.g. "1920x1080 · 25 fps · H.265".
 * @param {{width?: number, height?: number, fps?: number, codec?: string}} fields
 * @returns {string}
 */
export function formatDetectedSummary(fields) {
  const parts = [];
  if (fields.width && fields.height) parts.push(`${fields.width}x${fields.height}`);
  if (fields.fps) parts.push(`${fields.fps} fps`);
  if (fields.codec) parts.push({ h264: 'H.264', h265: 'H.265', mjpeg: 'MJPEG' }[fields.codec]);
  return parts.join(' · ');
}
