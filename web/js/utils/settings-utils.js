/**
 * LightNVR Settings Utilities
 * Provides cached access to server settings for frontend components
 */

import { fetchJSON } from '../fetch-utils.js';
import { nowMilliseconds } from './date-utils.js';

// Cache for settings
let settingsCache = null;
let settingsCacheTime = 0;
const CACHE_TTL = 60000; // 1 minute cache TTL

// In-flight promise deduplication: prevents N concurrent callers from each
// firing a separate /api/settings request before the first response returns.
let settingsInflight = null;

/**
 * Fetch settings from the server with caching
 * @param {boolean} forceRefresh - Force refresh the cache
 * @returns {Promise<Object>} - Settings object
 */
export async function getSettings(forceRefresh = false) {
  const now = nowMilliseconds();

  // Return cached settings if still valid
  if (!forceRefresh && settingsCache && (now - settingsCacheTime) < CACHE_TTL) {
    return settingsCache;
  }

  // If a fetch is already in-flight, return the same promise so all concurrent
  // callers share one request instead of firing N parallel requests.
  if (!forceRefresh && settingsInflight) {
    return settingsInflight;
  }

  settingsInflight = fetchJSON('/api/settings', {
    timeout: 10000,
    retries: 1,
    retryDelay: 500
  }).then(settings => {
    settingsCache = settings;
    settingsCacheTime = nowMilliseconds();
    settingsInflight = null;
    return settings;
  }).catch(error => {
    settingsInflight = null;
    console.error('Failed to fetch settings:', error);

    // Return cached settings if available, even if stale
    if (settingsCache) {
      console.warn('Using stale cached settings');
      return settingsCache;
    }

    // Return defaults if no cache available
    return getDefaultSettings();
  });

  return settingsInflight;
}

/**
 * Get the go2rtc API port from settings
 * @returns {Promise<number>} - go2rtc API port
 */
export async function getGo2rtcApiPort() {
  const settings = await getSettings();
  return settings.go2rtc_api_port || 1984; // Default to 1984 if not set
}

/**
 * Get the go2rtc base URL for HTTP API calls (HLS, WebRTC SDP, etc.)
 *
 * go2rtc is configured with base_path: /go2rtc/, so all its API endpoints
 * are served under the /go2rtc prefix (e.g., /go2rtc/api/streams).
 *
 * Over HTTPS: Routes through external reverse proxy at /go2rtc/* which forwards
 * to go2rtc.
 *
 * Over HTTP: go2rtc is reached directly on its own port (default 1984); camera
 * media never goes through lightNVR's /go2rtc/* proxy.
 *
 * @returns {Promise<string>} - go2rtc base URL (e.g., "https://hostname/go2rtc" or "http://hostname:1984/go2rtc")
 */
export async function getGo2rtcBaseUrl() {
  // Over HTTPS, use the external reverse proxy (nginx, ingress, etc.)
  // which handles both HTTP and WebSocket to /go2rtc/*
  if (window.location.protocol === 'https:') {
    return `${window.location.origin}/go2rtc`;
  }

  // Over HTTP (local dev), connect directly to go2rtc's port
  // keep behavior compatible with local setups that bypass the web reverse proxy
  const port = await getGo2rtcApiPort();
  return `http://${window.location.hostname}:${port}/go2rtc`;
}

/**
 * Synchronous variant of getGo2rtcBaseUrl() for callers that cannot await,
 * such as <img src> snapshot URLs. Uses the cached settings port when it has
 * been loaded, otherwise the default 1984.
 *
 * @returns {string} - go2rtc base URL
 */
export function getGo2rtcBaseUrlSync() {
  if (window.location.protocol === 'https:') {
    return `${window.location.origin}/go2rtc`;
  }

  const port = settingsCache?.go2rtc_api_port || 1984;
  return `http://${window.location.hostname}:${port}/go2rtc`;
}

/**
 * Get the go2rtc WebSocket URL for MSE streaming.
 *
 * lightNVR's reverse proxy at /go2rtc/* currently supports standard HTTP-based
 * endpoints (including WebRTC SDP) used by <video/> playback.
 * MSE streaming requires a WebSocket upgrade; proxy support depends on your
 * reverse proxy configuration.
 *
 * Over HTTP:  ws://hostname:go2rtc_port/go2rtc  (direct to go2rtc)
 * Over HTTPS: wss://hostname/go2rtc              (external reverse proxy handles WS)
 *
 * @returns {Promise<string>} - WebSocket-compatible go2rtc base URL
 */
export async function getGo2rtcWebSocketUrl() {
  // Over HTTPS, use the reverse proxy endpoint. If your reverse proxy does
  // not support WebSocket upgrades, MSE fallback may fail and return error.
  if (window.location.protocol === 'https:') {
    return `wss://${window.location.host}/go2rtc`;
  }
  // Over HTTP, connect directly to go2rtc's port (bypass lightNVR's HTTP-only proxy)
  const port = await getGo2rtcApiPort();
  return `ws://${window.location.hostname}:${port}/go2rtc`;
}

/**
 * Get default settings (used as fallback)
 * @returns {Object} - Default settings object
 */
function getDefaultSettings() {
  return {
    go2rtc_enabled: true,
    go2rtc_api_port: 1984,
    webrtc_disabled: false,
    web_port: 8080,
    web_auth_enabled: true // Default to auth enabled for safety
  };
}

// Cache for go2rtc availability check
let go2rtcAvailableCache = null;
let go2rtcAvailableCacheTime = 0;
// 5-minute TTL: go2rtc doesn't go up/down during normal viewing sessions.
// A short TTL caused false-negative health checks when go2rtc was busy serving
// many streams — the check timed out, flipped the cache to false, and caused
// a stampede of re-registration requests from HLS.js error-recovery loops.
const GO2RTC_CACHE_TTL = 300000;

// In-flight promise deduplication for go2rtc availability checks
let go2rtcAvailableInflight = null;

/**
 * Check if go2rtc is available and responding
 * Tries to reach go2rtc's API endpoint with a short timeout
 * @param {boolean} forceRefresh - Force refresh the cache
 * @returns {Promise<boolean>} - true if go2rtc is available
 */
export async function isGo2rtcAvailable(forceRefresh = false) {
  const now = nowMilliseconds();

  // Return cached result if still valid
  if (!forceRefresh && go2rtcAvailableCache !== null && (now - go2rtcAvailableCacheTime) < GO2RTC_CACHE_TTL) {
    return go2rtcAvailableCache;
  }

  // Share a single in-flight request among all concurrent callers
  if (!forceRefresh && go2rtcAvailableInflight) {
    return go2rtcAvailableInflight;
  }

  go2rtcAvailableInflight = (async () => {
    try {
      const baseUrl = await getGo2rtcBaseUrl();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000); // 3 second timeout

      const response = await fetch(`${baseUrl}/api/streams`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const available = response.ok;
      go2rtcAvailableCache = available;
      go2rtcAvailableCacheTime = nowMilliseconds();

      if (!available) {
        console.warn(`go2rtc API responded with status ${response.status}`);
      }
      return available;
    } catch (error) {
      // If we previously confirmed go2rtc was up, treat a timeout/network error
      // as a transient false positive rather than declaring the service down.
      // go2rtc under load (e.g. 60+ simultaneous HLS streams) may be slow to
      // respond to health checks even though it is serving streams correctly.
      if (go2rtcAvailableCache === true) {
        console.warn(`go2rtc health check failed (${error.message}) but was previously available — assuming still up`);
        go2rtcAvailableCacheTime = nowMilliseconds(); // reset TTL so we don't spam retries
        return true;
      }
      console.warn('go2rtc is not available:', error.message);
      go2rtcAvailableCache = false;
      go2rtcAvailableCacheTime = nowMilliseconds();
      return false;
    } finally {
      go2rtcAvailableInflight = null;
    }
  })();

  return go2rtcAvailableInflight;
}

/**
 * Check if go2rtc is enabled in settings
 * This checks the configuration setting (not runtime availability)
 * @returns {Promise<boolean>} - true if go2rtc is enabled in settings
 */
export async function isGo2rtcEnabled() {
  const settings = await getSettings();
  // Default to true for backward compatibility
  return settings.go2rtc_enabled !== undefined ? settings.go2rtc_enabled : true;
}

/**
 * Check if force native HLS is enabled in settings
 * When enabled, the web interface uses lightNVR's native FFmpeg-based HLS
 * instead of go2rtc's HLS, even when go2rtc is running.
 * @returns {Promise<boolean>} - true if force native HLS is enabled
 */
export async function isForceNativeHls() {
  const settings = await getSettings();
  return settings.go2rtc_force_native_hls === true;
}

/**
 * Clear the settings cache
 */
export function clearSettingsCache() {
  settingsCache = null;
  settingsCacheTime = 0;
  settingsInflight = null;
  go2rtcAvailableCache = null;
  go2rtcAvailableCacheTime = 0;
  go2rtcAvailableInflight = null;
}
