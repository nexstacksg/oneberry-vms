/**
 * Camera search (sidebar camera list, Manage Cameras): by camera name, IP
 * address (or host name), RTSP link and tags. The user name and password
 * inside an RTSP link are never searched or shown, so typing a password
 * cannot reveal which camera uses it.
 */

/** RTSP link without its user name and password. */
export function stripUrlCredentials(url) {
  const text = String(url || '').trim();
  if (!text) return '';
  return text.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, '$1');
}

/** Host (IP address or name) of a link, or '' when it has none. */
export function getUrlHost(url) {
  const text = stripUrlCredentials(url);
  const match = text.match(/^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]+\]|[^/:?#]+)/i);
  return match ? match[1].replace(/^\[|\]$/g, '') : '';
}

/** Words of the search text (all of them must match). */
export function parseCameraSearch(query) {
  return String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Does the camera match every word of the search?
 * @returns {null | { field: 'name'|'tag'|'ip'|'url', hint: string }} null when it does not match;
 *          otherwise what matched, with a short hint to show under the name
 *          (empty when the name itself matched)
 */
export function matchCameraSearch(stream, terms) {
  if (!stream) return null;
  if (!terms || terms.length === 0) return { field: 'name', hint: '' };

  const name = String(stream.name || '').toLowerCase();
  const urls = [stream.url, stream.secondary_url]
    .map(stripUrlCredentials)
    .filter(Boolean);
  const hosts = urls.map(getUrlHost).filter(Boolean);
  const urlsLower = urls.map((url) => url.toLowerCase());
  const hostsLower = hosts.map((host) => host.toLowerCase());
  const tags = String(stream.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
  const tagsLower = tags.map((tag) => tag.toLowerCase());

  let field = 'name';
  let hint = '';
  for (const term of terms) {
    if (name.includes(term)) continue;
    const tagIndex = tagsLower.findIndex((tag) => tag.includes(term));
    if (tagIndex >= 0) {
      if (field === 'name') field = 'tag';
      hint = hint || `#${tags[tagIndex]}`;
      continue;
    }
    const hostIndex = hostsLower.findIndex((host) => host.includes(term));
    if (hostIndex >= 0) {
      if (field !== 'url') field = 'ip';
      hint = hint || hosts[hostIndex];
      continue;
    }
    const urlIndex = urlsLower.findIndex((url) => url.includes(term));
    if (urlIndex >= 0) {
      field = 'url';
      hint = urls[urlIndex];
      continue;
    }
    return null;
  }
  return { field, hint };
}
