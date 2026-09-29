import {
  getStoredStreamQuality,
  getStreamQualitySource,
} from './stream-quality-utils.js';
import { getGo2rtcBaseUrlSync } from './settings-utils.js';

const WARMUP_THROTTLE_MS = 5000;
const WARMUP_TIMEOUT_MS = 3000;
const SNAPSHOT_PRELOAD_THROTTLE_MS = 30000;
const SNAPSHOT_PRELOAD_GAP_MS = 750;
const WARMUP_STORAGE_KEY = 'oneberry-live-warmup:last';
const SNAPSHOT_STORAGE_KEY = 'oneberry-live-snapshots:last';

let warmupInFlight = null;
let snapshotPreloadInFlight = false;

function now() {
  return Date.now();
}

function getStoredTimestamp(key) {
  try {
    const value = sessionStorage.getItem(key);
    const timestamp = value ? Number(value) : 0;
    return Number.isFinite(timestamp) ? timestamp : 0;
  } catch {
    return 0;
  }
}

function setStoredTimestamp(key, value) {
  try {
    sessionStorage.setItem(key, String(value));
  } catch {
    // Ignore storage failures; warmup still works for this page.
  }
}

function shouldThrottle(key, throttleMs) {
  const last = getStoredTimestamp(key);
  return last > 0 && now() - last < throttleMs;
}


export function buildGo2rtcSnapshotUrl(streamSource, cache = '30s') {
  if (!streamSource) {
    return '';
  }

  const params = new URLSearchParams({
    src: streamSource,
    cache,
  });

  return `${getGo2rtcBaseUrlSync()}/api/frame.jpeg?${params.toString()}`;
}

export function startLiveWarmup({ force = false } = {}) {
  if (warmupInFlight) {
    return warmupInFlight;
  }

  if (!force && shouldThrottle(WARMUP_STORAGE_KEY, WARMUP_THROTTLE_MS)) {
    return Promise.resolve(null);
  }

  setStoredTimestamp(WARMUP_STORAGE_KEY, now());
  const controller = typeof AbortController !== 'undefined'
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? globalThis.setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS)
    : null;

  warmupInFlight = fetch('/api/streams?warmup=1', {
    credentials: 'same-origin',
    cache: 'no-store',
    signal: controller?.signal,
  })
    .catch((error) => {
      if (error?.name !== 'AbortError') {
        console.warn('Live camera warmup failed:', error);
      }
      return null;
    })
    .finally(() => {
      if (timeoutId) {
        globalThis.clearTimeout(timeoutId);
      }
      warmupInFlight = null;
    });

  return warmupInFlight;
}

export function preloadLiveSnapshots(streams, { limit = 2, force = false } = {}) {
  if (snapshotPreloadInFlight || !Array.isArray(streams) || streams.length === 0) {
    return;
  }

  if (!force && shouldThrottle(SNAPSHOT_STORAGE_KEY, SNAPSHOT_PRELOAD_THROTTLE_MS)) {
    return;
  }

  const candidates = streams
    .filter((stream) => (
      stream &&
      stream.name &&
      stream.enabled !== false &&
      stream.streaming_enabled !== false &&
      stream.privacy_mode !== true &&
      stream.is_deleted !== true
    ))
    .slice(0, limit);

  if (candidates.length === 0) {
    return;
  }

  setStoredTimestamp(SNAPSHOT_STORAGE_KEY, now());
  snapshotPreloadInFlight = true;

  const loadSnapshot = (stream) => new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = resolve;
    img.onerror = resolve;
    // Preload the snapshot for the source the live view will actually display
    // (the "__low" sub-stream when low quality is selected). This makes the
    // poster a warm cache hit instead of triggering a cold go2rtc frame grab.
    const previewSource =
      getStreamQualitySource(stream, getStoredStreamQuality(stream)) || stream.name;
    img.src = buildGo2rtcSnapshotUrl(previewSource);
  });

  const loadSequentially = async () => {
    for (const stream of candidates) {
      await loadSnapshot(stream);
      await new Promise(resolve => setTimeout(resolve, SNAPSHOT_PRELOAD_GAP_MS));
    }
  };

  loadSequentially().finally(() => {
    snapshotPreloadInFlight = false;
  });
}
