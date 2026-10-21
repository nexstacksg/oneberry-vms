/**
 * WebRTCVideoCell Component
 * A self-contained component for displaying a WebRTC video stream
 * with optional two-way audio (backchannel) support
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { DetectionOverlay } from './DetectionOverlay.jsx';
import { SnapshotButton } from './SnapshotManager.jsx';
import { LoadingIndicator } from './LoadingIndicator.jsx';
import { showStatusMessage } from './ToastContainer.jsx';
import { PTZControls } from './PTZControls.jsx';
import { FullscreenTimelineOverlay } from './FullscreenTimelineOverlay.jsx';
import { ConfirmDialog } from './UI.jsx';
import { getGo2rtcBaseUrl } from '../../utils/settings-utils.js';
import { currentDateInputValue, getLocalDayIsoRange } from '../../utils/date-utils.js';
import { forceNavigation } from '../../utils/navigation-utils.js';
import { formatUtils } from './recordings/formatUtils.js';
import { useI18n } from '../../i18n.js';
import { useQueryClient, fetchJSON } from '../../query-client.js';
import { createPlayerTelemetry } from '../../utils/player-telemetry.js';
import { StreamQualitySelector } from './StreamQualitySelector.jsx';
import { useItemQuality } from './useItemQuality.js';
import { captureVideoSnapshot, createPrivacyHandlers } from './video-cell-helpers.js';
import { getForcedAspectVideoStyle } from '../../utils/aspect-ratio-utils.js';
import { PrivacyModeOverlays, StreamStatusBadge } from './VideoCellOverlays.jsx';
import { LivePreviewPoster } from './LivePreviewPoster.jsx';
import 'webrtc-adapter';
import {
  findContainingSegmentIndex,
  findNearestSegmentIndex,
  formatTimestampAsLocalDate,
  getPlayableSegmentTimestamp
} from './timeline/timelineUtils.js';

// Retry configuration for sending WebRTC offers to go2rtc.
// Adjust these values to tune reliability vs. latency.
// Configuration for detecting lack of incoming video data.
// MAX_VIDEO_DATA_CHECKS × VIDEO_DATA_CHECK_INTERVAL_MS defines the total
// time we will wait for video frames before surfacing an error.
const MAX_VIDEO_DATA_CHECKS = 12; // 12 checks × 5,000 ms (5s) interval = 60s total
const VIDEO_DATA_CHECK_INTERVAL_MS = 5000; // 5 seconds between checks
const MIN_NO_DATA_CHECKS_BEFORE_RETRY = 6; // 6 checks × 5 s = 30 s, longer than a camera GOP
const MAX_NO_DATA_RECONNECT_ATTEMPTS = 3;
const MAX_OFFER_FAILURE_RECONNECT_ATTEMPTS = 2;
const OFFER_RETRY_DELAYS_MS = [100, 200, 400, 750, 1000, 1500, 2000, 3000];
const OFFER_RETRY_JITTER_MS = 250;
const OFFER_FAILURE_REFRESH_DELAY_MS = 1200;
const WEBRTC_OFFER_TIMEOUT_MS = 15000;
const FULLSCREEN_ARROW_SEEK_SECONDS = 10;
// A recording that ends this close to now is the newest one: after it comes live
const FULLSCREEN_CAUGHT_UP_TO_LIVE_SECONDS = 180;
const FULLSCREEN_SEEK_SETTLE_TOLERANCE_SECONDS = 1.5;
const FULLSCREEN_SEGMENT_CACHE_TTL_MS = 5 * 60 * 1000;
const FULLSCREEN_PLAYBACK_WARMUP_TTL_MS = 20 * 1000;
const FULLSCREEN_SEAMLESS_ADVANCE_REMAINING_SECONDS = 0.85;
const DEFAULT_ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

let iceServersCache = null;
let iceServersInflight = null;
let go2rtcBaseUrlInflight = null;
const fullscreenSegmentCache = new Map();
const fullscreenPlaybackWarmups = new Map();

async function getGo2rtcBaseUrlCached() {
  if (!go2rtcBaseUrlInflight) {
    go2rtcBaseUrlInflight = getGo2rtcBaseUrl();
  }

  return go2rtcBaseUrlInflight;
}

function primeIceServersCache() {
  if (iceServersCache) {
    return;
  }

  if (!iceServersInflight) {
    iceServersInflight = fetch('/api/ice-servers')
      .then(async (iceResponse) => {
        if (!iceResponse.ok) {
          return DEFAULT_ICE_SERVERS;
        }

        const iceConfig = await iceResponse.json();
        if (iceConfig.ice_servers && iceConfig.ice_servers.length > 0) {
          console.log(`Using ${iceConfig.ice_servers.length} ICE servers from config`);
          return iceConfig.ice_servers;
        }

        return DEFAULT_ICE_SERVERS;
      })
      .catch((err) => {
        console.warn('Failed to fetch ICE servers config, using defaults:', err);
        return DEFAULT_ICE_SERVERS;
      })
      .then((iceServers) => {
        iceServersCache = iceServers;
        return iceServers;
      });
  }
}

function getIceServersForStartup() {
  if (iceServersCache) {
    return iceServersCache;
  }

  primeIceServersCache();
  return DEFAULT_ICE_SERVERS;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) {
    return min;
  }

  const safeMin = Number.isFinite(min) ? min : value;
  const safeMax = Number.isFinite(max) ? max : value;

  return Math.min(Math.max(value, safeMin), safeMax);
}

function getJitteredOfferRetryDelay(baseDelay) {
  return baseDelay + Math.floor(Math.random() * OFFER_RETRY_JITTER_MS);
}

function getPreviewFrameIndexForTimelineSample(segment, sampleTimestamp) {
  const start = Number(segment?.start_timestamp);
  const end = Number(segment?.end_timestamp);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return 1;
  }

  const ratio = clamp((sampleTimestamp - start) / (end - start), 0, 1);
  if (ratio < 0.33) {
    return 0;
  }
  if (ratio < 0.66) {
    return 1;
  }

  return 2;
}

function buildFullscreenPlaybackSample(segment, sampleTimestamp) {
  if (!segment || !segment.id) {
    return null;
  }

  const segmentStart = Number(segment.start_timestamp);
  const segmentEnd = Number(segment.end_timestamp);
  if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd <= segmentStart) {
    return null;
  }

  const safeTimestamp = getPlayableSegmentTimestamp(segment, sampleTimestamp);

  if (!Number.isFinite(safeTimestamp)) {
    return null;
  }

  const offsetSeconds = Math.max(0, safeTimestamp - segmentStart);
  const segmentVersion = encodeURIComponent(`${segment.id}-${segmentStart}-${segmentEnd}`);
  const startOffset = Math.max(0, offsetSeconds - 0.05);

  return {
    key: `seek-${segment.id}-${safeTimestamp}`,
    timestamp: safeTimestamp,
    segmentId: segment.id,
    segmentStartTimestamp: segmentStart,
    segmentEndTimestamp: segmentEnd,
    offsetSeconds,
    thumbUrl: `/api/recordings/thumbnail/${segment.id}/${getPreviewFrameIndexForTimelineSample(segment, safeTimestamp)}`,
    playbackUrl: `/api/recordings/play/${segment.id}?v=${segmentVersion}#t=${startOffset.toFixed(3)}`,
  };
}

function getFullscreenPlaybackStartTimestamp(sample) {
  const segmentStart = Number(sample?.segmentStartTimestamp);
  if (Number.isFinite(segmentStart)) {
    return segmentStart;
  }

  const timestamp = Number(sample?.timestamp);
  const offsetSeconds = Number(sample?.offsetSeconds);
  if (Number.isFinite(timestamp) && Number.isFinite(offsetSeconds)) {
    return timestamp - offsetSeconds;
  }

  return null;
}

function getFullscreenPlaybackTimestampFromVideo(sample, video) {
  const startTimestamp = getFullscreenPlaybackStartTimestamp(sample);
  const currentTime = Number(video?.currentTime);
  if (!Number.isFinite(startTimestamp) || !Number.isFinite(currentTime)) {
    return null;
  }

  return startTimestamp + currentTime;
}

function captureVideoFrame(video) {
  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    return null;
  }

  try {
    const maxWidth = 1920;
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));

    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }

    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.86);
  } catch (error) {
    console.debug('Unable to capture fullscreen playback transition frame', error);
    return null;
  }
}

function getFullscreenSegmentCacheKey(streamName, selectedDate) {
  return `${streamName}:${selectedDate}`;
}

function normalizeFullscreenSegments(rawSegments) {
  return [...(Array.isArray(rawSegments) ? rawSegments : [])]
    .filter((segment) => (
      segment &&
      segment.id &&
      Number.isFinite(Number(segment.start_timestamp)) &&
      Number.isFinite(Number(segment.end_timestamp))
    ))
    .sort((a, b) => Number(a.start_timestamp) - Number(b.start_timestamp));
}

async function fetchFullscreenSegments(streamName, selectedDate) {
  const cacheKey = getFullscreenSegmentCacheKey(streamName, selectedDate);
  const cached = fullscreenSegmentCache.get(cacheKey);
  const now = Date.now();

  if (cached?.segments && cached.expiresAt > now) {
    return cached.segments;
  }

  if (cached?.inflight) {
    return cached.inflight;
  }

  const dayRange = getLocalDayIsoRange(selectedDate);
  if (!dayRange?.startTime || !dayRange?.endTime) {
    return [];
  }

  const inflight = fetch(
    `/api/timeline/segments?stream=${encodeURIComponent(streamName)}&start=${encodeURIComponent(dayRange.startTime)}&end=${encodeURIComponent(dayRange.endTime)}`
  )
    .then(async (response) => {
      if (!response.ok) {
        return [];
      }

      const payload = await response.json();
      const segments = normalizeFullscreenSegments(payload?.segments);
      fullscreenSegmentCache.set(cacheKey, {
        segments,
        expiresAt: Date.now() + FULLSCREEN_SEGMENT_CACHE_TTL_MS,
        inflight: null,
      });
      return segments;
    })
    .catch((error) => {
      console.warn('Unable to fetch fullscreen timeline segments', error);
      fullscreenSegmentCache.delete(cacheKey);
      return [];
    });

  fullscreenSegmentCache.set(cacheKey, {
    segments: cached?.segments || [],
    expiresAt: cached?.expiresAt || 0,
    inflight,
  });

  return inflight;
}

function warmFullscreenPlaybackUrl(url) {
  if (!url || typeof document === 'undefined') {
    return;
  }

  if (fullscreenPlaybackWarmups.has(url)) {
    return;
  }

  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  const cleanup = () => {
    video.removeEventListener('loadeddata', cleanup);
    video.removeEventListener('error', cleanup);
    try {
      video.pause();
    } catch (error) {
      // Ignore cleanup failures.
    }
    video.removeAttribute('src');
    try {
      video.load();
    } catch (error) {
      // Ignore cleanup failures.
    }

    const timeoutId = fullscreenPlaybackWarmups.get(url);
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    fullscreenPlaybackWarmups.delete(url);
  };

  video.addEventListener('loadeddata', cleanup, { once: true });
  video.addEventListener('error', cleanup, { once: true });
  const timeoutId = window.setTimeout(cleanup, FULLSCREEN_PLAYBACK_WARMUP_TTL_MS);
  fullscreenPlaybackWarmups.set(url, timeoutId);

  try {
    video.load();
  } catch (error) {
    cleanup();
  }
}

function warmFullscreenPlaybackNeighborhood(segments, selectedIndex) {
  if (!Array.isArray(segments) || selectedIndex < 0) {
    return;
  }

  const indexes = new Set([selectedIndex - 1, selectedIndex, selectedIndex + 1]);
  indexes.forEach((index) => {
    const segment = segments[index];
    if (!segment) {
      return;
    }

    const segmentStart = Number(segment.start_timestamp);
    if (!Number.isFinite(segmentStart)) {
      return;
    }

    const sample = buildFullscreenPlaybackSample(segment, segmentStart);
    if (sample?.playbackUrl) {
      warmFullscreenPlaybackUrl(sample.playbackUrl);
    }
  });
}

function getSafeFullscreenPlaybackSpeed(speed) {
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

function applyFullscreenPlaybackSpeed(video, speed) {
  if (!video) {
    return;
  }

  const safeSpeed = getSafeFullscreenPlaybackSpeed(speed);
  try {
    video.defaultPlaybackRate = safeSpeed;
    video.playbackRate = safeSpeed;
  } catch (error) {
    console.warn('Unable to set fullscreen playback speed', error);
  }
}

// Connection quality classification thresholds
// Packet loss values are percentages (0-100), RTT and jitter are in seconds.
const CONNECTION_QUALITY_THRESHOLDS = {
  good: {
    maxLossPercent: 2,
    maxRttSeconds: 0.1,
    maxJitterSeconds: 0.03
  },
  fair: {
    maxLossPercent: 5,
    maxRttSeconds: 0.3,
    maxJitterSeconds: 0.1
  },
  poor: {
    maxLossPercent: 15,
    maxRttSeconds: 1
  }
};

/**
 * WebRTCVideoCell component
 * @param {Object} props - Component props
 * @param {Object} props.stream - Stream object
 * @param {Function} props.onToggleFullscreen - Fullscreen toggle handler
 * @param {string} props.streamId - Stream ID for stable reference
 * @param {string} [props.forcedAspectRatio] - Show the picture with this shape ("16:9"…), or "auto"
 * @param {Function} [props.onVideoDimensions] - (streamName, width, height) when the picture size is known
 * @param {string} [props.itemQuality] - This tile's resolution: 'auto' (by tile size), 'high' or 'low'
 * @param {Function} [props.onItemQualityChange] - Called when the user changes the tile's resolution
 * @param {boolean} [props.isOnlyItem] - The only camera on the layout (Auto then uses high quality)
 * @returns {JSX.Element} WebRTCVideoCell component
 */
export function WebRTCVideoCell({
  stream,
  streamId,
  onToggleFullscreen,
  initDelay = 0,
  showLabels = true,
  showControls = true,
  globalShowDetections = true,
  isPageFullscreen = false,
  forcedAspectRatio = 'auto',
  onVideoDimensions,
  itemQuality = 'auto',
  onItemQualityChange,
  isOnlyItem = false
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const forcedVideoStyle = getForcedAspectVideoStyle(forcedAspectRatio);
  const hasForcedAspect = Object.keys(forcedVideoStyle).length > 0;
  // H.264 version of the selected source, used when this browser cannot play
  // the camera's own codec (e.g. H.265 or MJPEG) over WebRTC: { from, source }
  const [h264Fallback, setH264Fallback] = useState(null);

  // Component state
  const [isLoading, setIsLoading] = useState(() => {
    // Derive initial loading state from the incoming stream, so that we
    // avoid flashing a loading indicator for streams that are already
    // playing/connected or known to be in an error state.
    if (!stream) {
      return true;
    }

    const status = stream.status || stream.state;
    if (status === 'error' || status === 'failed') {
      return false;
    }
    if (status === 'playing' || status === 'connected' || status === 'ready') {
      return false;
    }

    return true;
  });
  // Item resolution when the layout does not keep it (no onItemQualityChange)
  const [localItemQuality, setLocalItemQuality] = useState('auto');
  const [error, setError] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [connectionQuality, setConnectionQuality] = useState('unknown'); // 'unknown', 'good', 'fair', 'poor', 'bad'
  const [retryCount, setRetryCount] = useState(0); // Used to trigger WebRTC re-initialization
  const [showRefreshConfirm, setShowRefreshConfirm] = useState(false);
  const [isFullscreenCell, setIsFullscreenCell] = useState(false);
  const [fullscreenPlayback, setFullscreenPlayback] = useState(null);
  const [fullscreenPlaybackTimestamp, setFullscreenPlaybackTimestamp] = useState(null);
  const [fullscreenPlaybackSpeed, setFullscreenPlaybackSpeed] = useState(1);
  // Pause state shown on the fullscreen timeline: the recording player's, or the live view's
  const [isFullscreenPlaybackPaused, setIsFullscreenPlaybackPaused] = useState(false);
  const [isLivePaused, setIsLivePaused] = useState(false);
  // Set when the user paused the recording, so autoplay hooks do not resume it
  const fullscreenUserPausedRef = useRef(false);
  const fullscreenTogglePauseRef = useRef(null);

  function resumeLiveVideo() {
    const liveVideo = videoRef.current;
    if (liveVideo && liveVideo.paused) {
      liveVideo.play().catch(() => {});
    }
    setIsLivePaused(false);
  }

  // Timeline pause/play button and Space key: pause or resume what is on screen
  const handleFullscreenTogglePause = () => {
    if (fullscreenPlayback) {
      const playbackVideo = playbackVideoRef.current;
      if (!playbackVideo) return;
      if (playbackVideo.paused) {
        fullscreenUserPausedRef.current = false;
        applyFullscreenPlaybackSpeed(playbackVideo, fullscreenPlaybackSpeed);
        playbackVideo.play().catch(() => {});
      } else {
        fullscreenUserPausedRef.current = true;
        playbackVideo.pause();
      }
      return;
    }

    const liveVideo = videoRef.current;
    if (!liveVideo) return;
    if (isLivePaused) {
      resumeLiveVideo();
    } else {
      liveVideo.pause();
      setIsLivePaused(true);
    }
  };
  fullscreenTogglePauseRef.current = handleFullscreenTogglePause;
  const fullscreenPlaybackState = fullscreenPlayback
    ? (isFullscreenPlaybackPaused ? 'paused' : 'playing')
    : (isLivePaused ? 'live-paused' : 'live');
  const [fullscreenPlaybackCoverFrame, setFullscreenPlaybackCoverFrame] = useState(null);
  const [isFullscreenPlaybackFrameReady, setIsFullscreenPlaybackFrameReady] = useState(false);


  // Backchannel (two-way audio) state
  const [isTalking, setIsTalking] = useState(false);
  const [microphoneError, setMicrophoneError] = useState(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [talkMode, setTalkMode] = useState('ptt'); // 'ptt' (push-to-talk) or 'toggle'

  // Audio playback state (for hearing audio from camera)
  const [audioEnabled, setAudioEnabled] = useState(false);

  // Effect to directly set the muted property on the video element
  // This is necessary because React/Preact doesn't always update the muted attribute correctly
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.muted = !audioEnabled;
      console.log(`Set video muted=${!audioEnabled} for stream ${stream?.name || 'unknown'}`);

      // Debug: Log audio track info
      if (videoRef.current.srcObject) {
        const audioTracks = videoRef.current.srcObject.getAudioTracks();
        console.log(`Audio tracks for ${stream?.name}: ${audioTracks.length}`, audioTracks.map(t => ({
          id: t.id,
          label: t.label,
          enabled: t.enabled,
          muted: t.muted,
          readyState: t.readyState
        })));
      }
    }
  }, [audioEnabled, stream?.name]);

  // PTZ controls state
  const [showPTZControls, setShowPTZControls] = useState(false);

  // Privacy mode state
  const [showPrivacyConfirm, setShowPrivacyConfirm] = useState(false);
  const [privacyActive, setPrivacyActive] = useState(!!stream.privacy_mode);
  const [isTogglingEnabled, setIsTogglingEnabled] = useState(false);

  // Detection overlay visibility state (per-camera toggle, constrained by global toggle)
  const [localShowDetections, setLocalShowDetections] = useState(true);
  const showDetections = globalShowDetections && localShowDetections;
  const isTimelineFullscreenControls = isFullscreenCell || isPageFullscreen;
  const showFullStreamControls = !isTimelineFullscreenControls;

  const handleFullscreenPreviewSelect = (sample) => {
    // Picking a time on the timeline plays from there
    fullscreenUserPausedRef.current = false;
    if (!sample) {
      return;
    }

    const nextRequestId = fullscreenPlaybackRequestRef.current + 1;
    fullscreenPlaybackRequestRef.current = nextRequestId;
    fullscreenPlaybackCoverRequestRef.current = nextRequestId;
    fullscreenSeamlessAdvanceSegmentRef.current = null;
    warmFullscreenPlaybackUrl(sample.playbackUrl);

    const playbackVideo = playbackVideoRef.current;
    const lastGoodPlaybackFrame = fullscreenLastGoodPlaybackFrameRef.current;
    const currentPlaybackFrame = playbackVideo && !playbackVideo.ended && !playbackVideo.seeking
      ? captureVideoFrame(playbackVideo)
      : null;
    const transitionFrame =
      lastGoodPlaybackFrame ||
      currentPlaybackFrame ||
      captureVideoFrame(videoRef.current) ||
      fullscreenPlaybackCoverFrameRef.current ||
      sample.thumbUrl;
    setIsFullscreenPlaybackFrameReady(false);
    if (transitionFrame) {
      fullscreenPlaybackCoverFrameRef.current = transitionFrame;
      setFullscreenPlaybackCoverFrame(transitionFrame);
    }

    if (fullscreenPlayback &&
        playbackVideo &&
        sample.segmentId === fullscreenPlayback.segmentId) {
      const segmentDuration = Number.isFinite(playbackVideo.duration) ? playbackVideo.duration : Infinity;
      const nextOffset = Number.isFinite(segmentDuration)
        ? clamp(sample.offsetSeconds, 0, segmentDuration)
        : sample.offsetSeconds;
      const sampleStartTimestamp = getFullscreenPlaybackStartTimestamp(sample);
      const nextTimestamp = Number.isFinite(sampleStartTimestamp)
        ? sampleStartTimestamp + nextOffset
        : sample.timestamp;

      fullscreenPlaybackSeekTargetRef.current = nextTimestamp;
      setFullscreenPlayback((current) => current
        ? { ...current, timestamp: nextTimestamp, offsetSeconds: nextOffset }
        : sample);
      setFullscreenPlaybackTimestamp(nextTimestamp);
      fullscreenPlaybackTimestampRef.current = nextTimestamp;
      applyFullscreenPlaybackSpeed(playbackVideo, fullscreenPlaybackSpeed);
      try {
        playbackVideo.currentTime = nextOffset;
        playbackVideo.play().catch((error) => {
          console.debug('Fullscreen playback seek did not resume automatically', error);
        });
      } catch (error) {
        console.warn('Unable to seek fullscreen playback sample', error);
        setFullscreenPlayback(sample);
      }
      return;
    }

    fullscreenPlaybackSeekTargetRef.current = Number.isFinite(sample.timestamp) ? sample.timestamp : null;
    setFullscreenPlayback(sample);
    setFullscreenPlaybackTimestamp(sample.timestamp ?? null);
    fullscreenPlaybackTimestampRef.current = sample.timestamp ?? null;
  };
  const handleReturnToLive = () => {
    fullscreenPlaybackRequestRef.current += 1;
    if (playbackVideoRef.current) {
      try {
        playbackVideoRef.current.pause();
      } catch (error) {
        // Ignore pause failures during cleanup.
      }
      playbackVideoRef.current.removeAttribute('src');
      try {
        playbackVideoRef.current.load();
      } catch (error) {
        // Ignore cleanup failures.
      }
    }
    setFullscreenPlayback(null);
    setFullscreenPlaybackTimestamp(null);
    setIsFullscreenPlaybackFrameReady(false);
    resumeLiveVideo();
    fullscreenUserPausedRef.current = false;
    setIsFullscreenPlaybackPaused(false);
    fullscreenPlaybackTimestampRef.current = null;
    fullscreenPlaybackSeekTargetRef.current = null;
    fullscreenPlaybackCoverRequestRef.current += 1;
    fullscreenPlaybackCoverFrameRef.current = null;
    fullscreenLastGoodPlaybackFrameRef.current = null;
    fullscreenLastGoodPlaybackFrameAtRef.current = 0;
    fullscreenLastGoodPlaybackFrameSegmentRef.current = null;
    setFullscreenPlaybackCoverFrame(null);
  };

  const handleFullscreenPlaybackEnded = () => {
    if (!fullscreenPlayback) {
      return;
    }

    const segmentEnd = Number(fullscreenPlayback.segmentEndTimestamp);
    const fallbackTimestamp = Number.isFinite(segmentEnd)
      ? segmentEnd
      : fullscreenPlayback.timestamp ?? fullscreenPlaybackTimestampRef.current;

    if (Number.isFinite(fallbackTimestamp)) {
      setFullscreenPlaybackTimestamp(fallbackTimestamp);
      fullscreenPlaybackTimestampRef.current = fallbackTimestamp;
    }

    if (!Number.isFinite(segmentEnd)) {
      return;
    }

    const preloadedNext = fullscreenNextPlaybackRef.current;
    if (preloadedNext?.sample &&
        preloadedNext.sample.segmentId !== fullscreenPlayback.segmentId) {
      handleFullscreenPreviewSelect(preloadedNext.sample);
      return;
    }

    const requestId = fullscreenPlaybackRequestRef.current + 1;
    fullscreenPlaybackRequestRef.current = requestId;
    // Continue with the next recording, skipping over any gap
    resolveFullscreenPlaybackSample(segmentEnd + 1, {
      mode: 'forward'
    }).then((sample) => {
      if (requestId !== fullscreenPlaybackRequestRef.current) {
        return;
      }

      if (sample && sample.segmentId !== fullscreenPlayback.segmentId) {
        handleFullscreenPreviewSelect(sample);
        return;
      }

      // Played up to the newest recording: carry on with live instead of
      // sitting on the last frame
      if (segmentEnd >= Math.floor(Date.now() / 1000) - FULLSCREEN_CAUGHT_UP_TO_LIVE_SECONDS) {
        handleReturnToLive();
        return;
      }
      setIsFullscreenPlaybackPaused(true);
      showStatusMessage('End of recordings for this camera', 'info', 3000);
    });
  };


  // Refs
  const videoRef = useRef(null);
  const playbackVideoRef = useRef(null);
  const cellRef = useRef(null);
  // Which stream to play: the tile's Auto/High/Low setting (Nx Witness style)
  const {
    hasLowQuality,
    itemQuality: tileItemQuality,
    effectiveQuality,
    selectedStreamSource,
  } = useItemQuality(stream, {
    itemQuality: onItemQualityChange ? itemQuality : localItemQuality,
    isOnlyItem,
    isFullscreen: isFullscreenCell,
    sizeRef: cellRef,
  });
  const handleItemQualityChange = (quality) => {
    if (onItemQualityChange) {
      onItemQualityChange(quality);
    } else {
      setLocalItemQuality(quality);
    }
  };
  const peerConnectionRef = useRef(null);
  const detectionOverlayRef = useRef(null);
  const abortControllerRef = useRef(null);
  const connectionMonitorRef = useRef(null);
  const reconnectAttemptsRef = useRef(0);
  const connectionRefreshRequestedRef = useRef(false);  // Track if we've already requested a refresh for this connection attempt
  const noDataReconnectAttemptsRef = useRef(0); // Separate counter for ICE-connected-but-no-data retries
  const localStreamRef = useRef(null);
  const audioSenderRef = useRef(null);
  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const audioLevelIntervalRef = useRef(null);
  const disconnectRecoveryTimeoutRef = useRef(null);
  const fullscreenTimelineSeekRequestRef = useRef(0);
  const fullscreenPlaybackRequestRef = useRef(0);
  const fullscreenPlaybackTimestampRef = useRef(null);
  const fullscreenPlaybackSeekTargetRef = useRef(null);
  const fullscreenPlaybackCoverFrameRef = useRef(null);
  const fullscreenPlaybackCoverRequestRef = useRef(0);
  const fullscreenLastGoodPlaybackFrameRef = useRef(null);
  const fullscreenLastGoodPlaybackFrameAtRef = useRef(0);
  const fullscreenLastGoodPlaybackFrameSegmentRef = useRef(null);
  const fullscreenNextPlaybackRef = useRef(null);
  const fullscreenNextPlaybackCleanupRef = useRef(null);
  const fullscreenSeamlessAdvanceSegmentRef = useRef(null);

  const cleanupFullscreenNextPlayback = useCallback(() => {
    if (typeof fullscreenNextPlaybackCleanupRef.current === 'function') {
      fullscreenNextPlaybackCleanupRef.current();
    }
    fullscreenNextPlaybackCleanupRef.current = null;
    fullscreenNextPlaybackRef.current = null;
  }, []);

  const rememberFullscreenPlaybackFrame = useCallback((video, segmentId, options = {}) => {
    if (!video || video.readyState < 2 || video.seeking || !video.videoWidth || !video.videoHeight) {
      return;
    }

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!options.force && now - fullscreenLastGoodPlaybackFrameAtRef.current < 750) {
      return;
    }

    const frame = captureVideoFrame(video);
    if (!frame) {
      return;
    }

    fullscreenLastGoodPlaybackFrameRef.current = frame;
    fullscreenLastGoodPlaybackFrameAtRef.current = now;
    fullscreenLastGoodPlaybackFrameSegmentRef.current = segmentId ?? null;
  }, []);

  useEffect(() => {
    const syncFullscreenState = () => {
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
      setIsFullscreenCell(fullscreenElement === cellRef.current);
    };

    syncFullscreenState();
    document.addEventListener('fullscreenchange', syncFullscreenState);
    document.addEventListener('webkitfullscreenchange', syncFullscreenState);

    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreenState);
      document.removeEventListener('webkitfullscreenchange', syncFullscreenState);
    };
  }, []);

  useEffect(() => {
    if (!isFullscreenCell) {
      setFullscreenPlayback(null);
      setFullscreenPlaybackTimestamp(null);
      setFullscreenPlaybackCoverFrame(null);
      setIsFullscreenPlaybackFrameReady(false);
      cleanupFullscreenNextPlayback();
      // Leaving fullscreen always shows the live view running again
      resumeLiveVideo();
      fullscreenUserPausedRef.current = false;
      setIsFullscreenPlaybackPaused(false);
    }
  }, [cleanupFullscreenNextPlayback, isFullscreenCell]);

  useEffect(() => {
    const video = playbackVideoRef.current;
    if (!fullscreenPlayback || !video) {
      return undefined;
    }

    const targetSpeed = getSafeFullscreenPlaybackSpeed(fullscreenPlaybackSpeed);
    const seekTo = Math.max(0, fullscreenPlayback.offsetSeconds || 0);
    const applySeek = () => {
      applyFullscreenPlaybackSpeed(video, targetSpeed);
      video.muted = !audioEnabled;
      try {
        if (Math.abs(Number(video.currentTime) - seekTo) > 0.15) {
          if (typeof video.fastSeek === 'function') {
            video.fastSeek(seekTo);
          } else {
            video.currentTime = seekTo;
          }
        }
      } catch (error) {
        console.warn('Unable to seek fullscreen playback video', error);
      }

      video.play().catch((error) => {
        console.debug('Fullscreen playback autoplay did not start automatically', error);
      });
    };

    if (video.readyState >= 1) {
      applySeek();
      return undefined;
    }

    video.addEventListener('loadedmetadata', applySeek, { once: true });
    return () => video.removeEventListener('loadedmetadata', applySeek);
  }, [audioEnabled, fullscreenPlayback, fullscreenPlaybackSpeed]);

  const handleFullscreenPlaybackTimeUpdate = () => {
    const video = playbackVideoRef.current;
    if (!fullscreenPlayback || !video) {
      return;
    }

    const nextTimestamp = getFullscreenPlaybackTimestampFromVideo(fullscreenPlayback, video);
    if (Number.isFinite(nextTimestamp)) {
      const seekTarget = fullscreenPlaybackSeekTargetRef.current;
      if (Number.isFinite(seekTarget)) {
        const isStillSettling = video.seeking || Math.abs(nextTimestamp - seekTarget) > FULLSCREEN_SEEK_SETTLE_TOLERANCE_SECONDS;
        if (isStillSettling) {
          return;
        }

        fullscreenPlaybackSeekTargetRef.current = null;
      }

      setFullscreenPlaybackTimestamp(nextTimestamp);
      fullscreenPlaybackTimestampRef.current = nextTimestamp;
      rememberFullscreenPlaybackFrame(video, fullscreenPlayback.segmentId);
      requestFullscreenPlaybackCoverRelease(video);
    }

    const remainingSeconds = Number.isFinite(video.duration)
      ? video.duration - (Number(video.currentTime) || 0)
      : Infinity;
    const preloadedNext = fullscreenNextPlaybackRef.current;
    if (remainingSeconds <= FULLSCREEN_SEAMLESS_ADVANCE_REMAINING_SECONDS &&
        preloadedNext?.sample &&
        preloadedNext.video &&
        (preloadedNext.ready || preloadedNext.video.readyState >= 2) &&
        preloadedNext.sample.segmentId !== fullscreenPlayback.segmentId &&
        fullscreenSeamlessAdvanceSegmentRef.current !== fullscreenPlayback.segmentId) {
      rememberFullscreenPlaybackFrame(video, fullscreenPlayback.segmentId, { force: true });
      fullscreenSeamlessAdvanceSegmentRef.current = fullscreenPlayback.segmentId;
      handleFullscreenPreviewSelect(preloadedNext.sample);
    }
  };

  const handleFullscreenPlaybackSeeked = () => {
    const video = playbackVideoRef.current;
    if (!fullscreenPlayback || !video) {
      fullscreenPlaybackSeekTargetRef.current = null;
      return;
    }

    const nextTimestamp = getFullscreenPlaybackTimestampFromVideo(fullscreenPlayback, video);
    const seekTarget = fullscreenPlaybackSeekTargetRef.current;
    if (Number.isFinite(seekTarget) &&
        (!Number.isFinite(nextTimestamp) || Math.abs(nextTimestamp - seekTarget) > FULLSCREEN_SEEK_SETTLE_TOLERANCE_SECONDS)) {
      return;
    }

    if (Number.isFinite(nextTimestamp)) {
      setFullscreenPlaybackTimestamp(nextTimestamp);
      fullscreenPlaybackTimestampRef.current = nextTimestamp;
      rememberFullscreenPlaybackFrame(video, fullscreenPlayback.segmentId, { force: true });
    }

    fullscreenPlaybackSeekTargetRef.current = null;
    requestFullscreenPlaybackCoverRelease(video, fullscreenPlaybackCoverRequestRef.current);
  };

  const releaseFullscreenPlaybackCoverIfReady = (
    video = playbackVideoRef.current,
    requestId = fullscreenPlaybackCoverRequestRef.current
  ) => {
    if (requestId !== fullscreenPlaybackCoverRequestRef.current) {
      return;
    }

    if (!fullscreenPlayback || !video || video.readyState < 2) {
      return;
    }

    const nextTimestamp = getFullscreenPlaybackTimestampFromVideo(fullscreenPlayback, video);
    const seekTarget = fullscreenPlaybackSeekTargetRef.current;
    if (Number.isFinite(seekTarget) &&
        (!Number.isFinite(nextTimestamp) || Math.abs(nextTimestamp - seekTarget) > FULLSCREEN_SEEK_SETTLE_TOLERANCE_SECONDS)) {
      return;
    }

    // `canplay` can fire before the new recording has painted in fullscreen.
    // Keep the previous decoded frame over the player until this element can
    // provide a real frame, otherwise the browser may expose its black backing
    // surface during segment-to-segment source changes.
    const decodedFrame = captureVideoFrame(video);
    if (decodedFrame) {
      fullscreenLastGoodPlaybackFrameRef.current = decodedFrame;
      fullscreenLastGoodPlaybackFrameAtRef.current = typeof performance !== 'undefined' ? performance.now() : Date.now();
      fullscreenLastGoodPlaybackFrameSegmentRef.current = fullscreenPlayback.segmentId ?? null;
    } else if (video.readyState < 3) {
      return;
    }

    fullscreenPlaybackCoverFrameRef.current = null;
    setIsFullscreenPlaybackFrameReady(true);
    setFullscreenPlaybackCoverFrame(null);
  };

  const requestFullscreenPlaybackCoverRelease = (
    video = playbackVideoRef.current,
    requestId = fullscreenPlaybackCoverRequestRef.current
  ) => {
    if (!video) {
      return;
    }

    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => releaseFullscreenPlaybackCoverIfReady(video, requestId));
      return;
    }

    requestAnimationFrame(() => releaseFullscreenPlaybackCoverIfReady(video, requestId));
  };

  useEffect(() => {
    fullscreenPlaybackTimestampRef.current = fullscreenPlaybackTimestamp;
  }, [fullscreenPlaybackTimestamp]);

  useEffect(() => {
    fullscreenPlaybackCoverFrameRef.current = fullscreenPlaybackCoverFrame;
  }, [fullscreenPlaybackCoverFrame]);

  useEffect(() => {
    const video = playbackVideoRef.current;
    if (!video || !isFullscreenCell) {
      return;
    }

    applyFullscreenPlaybackSpeed(video, fullscreenPlaybackSpeed);
    video.muted = !audioEnabled;
  }, [audioEnabled, fullscreenPlaybackSpeed, isFullscreenCell]);

  const resolveFullscreenPlaybackSample = useCallback(async (targetTimestamp, options = {}) => {
    if (!stream?.name || !Number.isFinite(targetTimestamp)) {
      return null;
    }

    const {
      mode = 'nearest',
      maxForwardGapSeconds = null
    } = options;
    const safeTargetTimestamp = Math.floor(Math.max(targetTimestamp, 0));
    const dayOffsets = [-2, -1, 0, 1, 2];

    const segmentGroups = await Promise.allSettled(
      dayOffsets.map(async (dayOffset) => {
        const dayDate = formatTimestampAsLocalDate(safeTargetTimestamp + (dayOffset * 86400));
        if (!dayDate) {
          return [];
        }

        return fetchFullscreenSegments(stream.name, dayDate);
      })
    );

    const allSegmentsMap = new Map();
    segmentGroups.forEach((result) => {
      if (result.status !== 'fulfilled' || !Array.isArray(result.value)) {
        return;
      }

      result.value.forEach((segment) => {
        if (!segment || !segment.id || allSegmentsMap.has(segment.id)) {
          return;
        }

        allSegmentsMap.set(segment.id, segment);
      });
    });

    if (!allSegmentsMap.size) {
      return null;
    }

    const segments = [...allSegmentsMap.values()].sort((a, b) => Number(a.start_timestamp) - Number(b.start_timestamp));
    const containingIndex = findContainingSegmentIndex(segments, safeTargetTimestamp);
    if (mode === 'forward') {
      const forwardIndex = containingIndex !== -1
        ? containingIndex
        : segments.findIndex((segment) => Number(segment.end_timestamp) >= safeTargetTimestamp);

      if (forwardIndex === -1) {
        return null;
      }

      const segment = segments[forwardIndex];
      const segmentStart = Number(segment.start_timestamp);
      if (Number.isFinite(maxForwardGapSeconds) &&
          Number.isFinite(segmentStart) &&
          segmentStart > safeTargetTimestamp &&
          segmentStart - safeTargetTimestamp > maxForwardGapSeconds) {
        return null;
      }

      const sample = buildFullscreenPlaybackSample(segment, Math.max(safeTargetTimestamp, segmentStart));
      if (sample?.playbackUrl) {
        warmFullscreenPlaybackNeighborhood(segments, forwardIndex);
      }

      return sample;
    }

    const sampleIndex = containingIndex !== -1
      ? containingIndex
      : findNearestSegmentIndex(segments, safeTargetTimestamp);
    if (sampleIndex === -1) {
      return null;
    }

    const sample = buildFullscreenPlaybackSample(segments[sampleIndex], safeTargetTimestamp);
    if (sample?.playbackUrl) {
      warmFullscreenPlaybackNeighborhood(segments, sampleIndex);
    }

    return sample;
  }, [stream?.name]);

  useEffect(() => {
    cleanupFullscreenNextPlayback();

    if (!isFullscreenCell || !fullscreenPlayback) {
      return undefined;
    }

    const segmentEnd = Number(fullscreenPlayback.segmentEndTimestamp);
    if (!Number.isFinite(segmentEnd)) {
      return undefined;
    }

    let cancelled = false;

    resolveFullscreenPlaybackSample(segmentEnd + 1, {
      mode: 'forward',
      maxForwardGapSeconds: 5
    }).then((sample) => {
      if (cancelled ||
          !sample?.playbackUrl ||
          sample.segmentId === fullscreenPlayback.segmentId) {
        return;
      }

      const preloadVideo = document.createElement('video');
      preloadVideo.preload = 'auto';
      preloadVideo.muted = true;
      preloadVideo.playsInline = true;
      preloadVideo.src = sample.playbackUrl;

      const preloadedPlayback = {
        sample,
        video: preloadVideo,
        ready: preloadVideo.readyState >= 2
      };

      const markReady = () => {
        preloadedPlayback.ready = true;
      };

      const cleanup = () => {
        preloadVideo.removeEventListener('loadeddata', markReady);
        preloadVideo.removeEventListener('canplay', markReady);
        try {
          preloadVideo.pause();
        } catch (error) {
          // Ignore cleanup failures.
        }
        preloadVideo.removeAttribute('src');
        try {
          preloadVideo.load();
        } catch (error) {
          // Ignore cleanup failures.
        }
        if (fullscreenNextPlaybackCleanupRef.current === cleanup) {
          fullscreenNextPlaybackCleanupRef.current = null;
        }
        if (fullscreenNextPlaybackRef.current?.sample?.segmentId === sample.segmentId) {
          fullscreenNextPlaybackRef.current = null;
        }
      };

      preloadVideo.addEventListener('loadeddata', markReady);
      preloadVideo.addEventListener('canplay', markReady);

      fullscreenNextPlaybackRef.current = preloadedPlayback;
      fullscreenNextPlaybackCleanupRef.current = cleanup;

      try {
        preloadVideo.load();
      } catch (error) {
        cleanup();
      }
    });

    return () => {
      cancelled = true;
      cleanupFullscreenNextPlayback();
    };
  }, [
    cleanupFullscreenNextPlayback,
    fullscreenPlayback?.segmentEndTimestamp,
    fullscreenPlayback?.segmentId,
    isFullscreenCell,
    resolveFullscreenPlaybackSample
  ]);

  useEffect(() => {
    if (!isFullscreenCell) {
      return undefined;
    }

    const handleFullscreenTimelineKeys = (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }

      const isSpace = event.key === ' ' || event.code === 'Space';
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && !isSpace) {
        return;
      }

      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
      if (fullscreenElement !== cellRef.current) {
        return;
      }
      // Leave typing in the date field alone
      if (event.target instanceof HTMLElement && event.target.closest('input, select, textarea')) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (isSpace) {
        fullscreenTogglePauseRef.current?.();
        return;
      }

      const directionSeconds = event.key === 'ArrowLeft' ? -FULLSCREEN_ARROW_SEEK_SECONDS : FULLSCREEN_ARROW_SEEK_SECONDS;
      const playbackVideo = playbackVideoRef.current;
      const nowTimestamp = Math.floor(Date.now() / 1000);
      const todayDate = currentDateInputValue();
      const timestampFromVideo = fullscreenPlayback
        ? getFullscreenPlaybackTimestampFromVideo(fullscreenPlayback, playbackVideo)
        : null;
      const baseTimestamp = Number.isFinite(timestampFromVideo)
        ? timestampFromVideo
        : Number.isFinite(fullscreenPlaybackTimestampRef.current)
          ? fullscreenPlaybackTimestampRef.current
          : nowTimestamp;

      let targetTimestamp = Math.floor(Math.max(0, baseTimestamp + directionSeconds));
      if (formatTimestampAsLocalDate(targetTimestamp) === todayDate) {
        targetTimestamp = Math.min(targetTimestamp, nowTimestamp);
      }
      const requestId = fullscreenTimelineSeekRequestRef.current + 1;

      fullscreenTimelineSeekRequestRef.current = requestId;
      setFullscreenPlaybackTimestamp(targetTimestamp);
      fullscreenPlaybackTimestampRef.current = targetTimestamp;
      fullscreenPlaybackSeekTargetRef.current = targetTimestamp;

      resolveFullscreenPlaybackSample(targetTimestamp).then((sample) => {
        if (requestId !== fullscreenTimelineSeekRequestRef.current) {
          return;
        }

        // Going back from live into the minute still being recorded: play the
        // end of the newest recording instead of staying on live
        if (sample && directionSeconds < 0 && targetTimestamp > Number(sample.segmentEndTimestamp)) {
          const newestEnd = Number(sample.segmentEndTimestamp);
          const backTarget = Math.max(Number(sample.segmentStartTimestamp) || 0, newestEnd - FULLSCREEN_ARROW_SEEK_SECONDS);
          resolveFullscreenPlaybackSample(backTarget).then((backSample) => {
            if (requestId !== fullscreenTimelineSeekRequestRef.current || !backSample) return;
            handleFullscreenPreviewSelect(backSample);
          });
          return;
        }
        // Past the newest recording is the part still being recorded: that is live
        const isAfterNewestRecording = sample &&
          targetTimestamp > Number(sample.segmentEndTimestamp) &&
          targetTimestamp >= Math.floor(Date.now() / 1000) - FULLSCREEN_CAUGHT_UP_TO_LIVE_SECONDS;
        if (!sample || isAfterNewestRecording) {
          fullscreenPlaybackSeekTargetRef.current = null;
          if (isAfterNewestRecording || targetTimestamp >= Math.floor(Date.now() / 1000) - 5) {
            // Nothing recorded yet at the live edge: show live
            handleReturnToLive();
            return;
          }
          // Keep the cursor on what is actually playing
          const currentTimestamp = fullscreenPlayback ? baseTimestamp : null;
          setFullscreenPlaybackTimestamp(currentTimestamp);
          fullscreenPlaybackTimestampRef.current = currentTimestamp;
          showStatusMessage(`No recording at ${new Date(targetTimestamp * 1000).toLocaleTimeString()}`, 'warning', 3000);
          return;
        }

        handleFullscreenPreviewSelect(sample);
      });
    };

    window.addEventListener('keydown', handleFullscreenTimelineKeys, { capture: true });
    return () => window.removeEventListener('keydown', handleFullscreenTimelineKeys, { capture: true });
  }, [fullscreenPlayback, fullscreenPlaybackSpeed, isFullscreenCell, resolveFullscreenPlaybackSample]);

  const setPlaybackVideoRef = (element) => {
    playbackVideoRef.current = element;
    if (element && !isFullscreenCell) {
      return;
    }

    if (element) {
      applyFullscreenPlaybackSpeed(element, fullscreenPlaybackSpeed);
    }
  };

  // Initialize WebRTC connection when component mounts
  useEffect(() => {
    if (!stream || !stream.name || !videoRef.current) return;

    const cameraStreamSource = selectedStreamSource || stream.name;
    const activeStreamSource = h264Fallback?.from === cameraStreamSource ? h264Fallback.source : cameraStreamSource;
    console.log(`Initializing WebRTC connection for stream ${stream.name} using go2rtc source ${activeStreamSource}`);
    setIsLoading(true);
    setError(null);

    // Reset the refresh flag for this new connection attempt
    connectionRefreshRequestedRef.current = false;

    // Store cleanup functions
    let connectionTimeout = null;
    let videoDataTimeout = null;
    let initDelayTimeout = null;
    let go2rtcBaseUrl = null;
    let disposed = false;

    // Async function to initialize WebRTC
    const initWebRTC = async () => {
      // Signal go2rtc directly on its own port (http://host:1984/go2rtc) rather
      // than through lightNVR's /go2rtc proxy. The URL is resolved once and
      // shared by all cells, so /api/settings is fetched only once.
      go2rtcBaseUrl = await getGo2rtcBaseUrlCached();
      // The cell may have unmounted while the URL was resolving; creating a
      // peer connection now would leak it past cleanup.
      if (disposed) return;
      console.log(`Using go2rtc base URL: ${go2rtcBaseUrl}`);

      // Fetch ICE server configuration from API (includes TURN if configured)
      const iceServers = getIceServersForStartup();

      // Create a new RTCPeerConnection
      const pc = new RTCPeerConnection({
        iceTransportPolicy: 'all',
        bundlePolicy: 'balanced',
        rtcpMuxPolicy: 'require',
        iceCandidatePoolSize: 0,
        iceServers,
      });

      peerConnectionRef.current = pc;

      // Set up event handlers
      pc.ontrack = (event) => {
      console.log(`Track received for stream ${stream.name}: ${event.track.kind}`, event);
      console.log(`Track muted: ${event.track.muted}, enabled: ${event.track.enabled}, readyState: ${event.track.readyState}`);

      const videoElement = videoRef.current;
      if (!videoElement) {
        console.error(`Video element not found for stream ${stream.name}`);
        return;
      }

      // Only set srcObject once to avoid interrupting pending play() calls
      // When multiple tracks arrive (video + audio), each triggers ontrack
      // Setting srcObject again interrupts the play() call from the first track
      if (event.streams && event.streams[0]) {
        if (!videoElement.srcObject || videoElement.srcObject !== event.streams[0]) {
          videoElement.srcObject = event.streams[0];
          console.log(`Set srcObject from ontrack event for stream ${stream.name}, tracks:`,
            event.streams[0].getTracks().map(t => `${t.kind}:${t.readyState}:muted=${t.muted}`));
        } else {
          console.log(`srcObject already set for stream ${stream.name}, skipping to avoid interrupting play()`);
        }
      }

      if (event.track.kind === 'video') {
        console.log(`Video track received for stream ${stream.name}`);

        // Track retry attempts for play()
        let playRetryCount = 0;
        const maxPlayRetries = 3;
        let playRetryTimeout = null;

        // Function to attempt play with retry logic
        const attemptPlay = () => {
          if (!videoElement || videoElement.paused === false) {
            // Already playing or element gone
            return;
          }

          console.log(`Attempting to play video for stream ${stream.name} (attempt ${playRetryCount + 1})`);
          videoElement.play()
            .then(() => {
              console.log(`Video play() succeeded for stream ${stream.name}`);
              playRetryCount = 0; // Reset on success
              if (playRetryTimeout !== null) {
                clearTimeout(playRetryTimeout);
                playRetryTimeout = null;
              }
            })
            .catch(err => {
              // AbortError is expected when srcObject changes or another play() is called
              // Don't treat it as a fatal error, just log and potentially retry
              if (err.name === 'AbortError') {
                console.log(`Video play() was interrupted for stream ${stream.name}, will retry if needed`);
                playRetryCount++;
                if (playRetryCount < maxPlayRetries) {
                  // Retry after a short delay
                  if (playRetryTimeout !== null) {
                    clearTimeout(playRetryTimeout);
                  }
                  playRetryTimeout = setTimeout(attemptPlay, 500);
                }
              } else if (err.name === 'NotAllowedError') {
                console.warn(`Autoplay blocked for stream ${stream.name}, user interaction required`);
                setError(t('live.webrtcAutoplayBlocked'));
              } else {
                console.error(`Video play() failed for stream ${stream.name}:`, err);
              }
            });
        };

        // Set a timeout to detect if no video data is received.
        // When ICE is connected but no video frames have arrived, go2rtc is
        // likely still establishing the RTSP connection to the camera.  We
        // keep the loading indicator up and periodically re-check instead of
        // immediately showing an error.
        if (videoDataTimeout) {
          clearTimeout(videoDataTimeout);
        }
        let videoDataCheckCount = 0;
        const maxVideoDataChecks = MAX_VIDEO_DATA_CHECKS;
        const videoDataCheckInterval = VIDEO_DATA_CHECK_INTERVAL_MS;

        const scheduleVideoDataCheck = () => {
          videoDataTimeout = setTimeout(() => {
            videoDataCheckCount++;

            // Video is playing or has dimensions — nothing to do
            if (videoElement && videoElement.videoWidth > 0 && !videoElement.paused) {
              return;
            }

            // Determine current ICE state (may be null if pc was cleaned up)
            const iceState = peerConnectionRef.current
              ? peerConnectionRef.current.iceConnectionState
              : 'closed';

            console.warn(
              `No video data for stream ${stream.name} after ${videoDataCheckCount * videoDataCheckInterval / 1000}s ` +
              `(check ${videoDataCheckCount}/${maxVideoDataChecks}, ICE: ${iceState}, ` +
              `readyState: ${videoElement ? videoElement.readyState : 'N/A'})`
            );

            // ICE itself failed or closed — show error immediately
            if (iceState === 'failed' || iceState === 'closed') {
              setError(t('live.webrtcConnectionLostRetry'));
              setIsLoading(false);
              return;
            }

            // ICE is still connected/checking — camera stream may still be
            // coming up.  Keep loading state and schedule another check unless
            // we've exceeded the maximum wait time.
            if (videoDataCheckCount < maxVideoDataChecks) {
              console.log(`ICE still ${iceState} for stream ${stream.name}, waiting for camera stream...`);
              // Re-attempt play() in case the element got stuck. Failures here are non-fatal;
              // the surrounding retry logic will handle recovery.
              if (videoElement && videoElement.paused) {
                videoElement.play().catch(err => {
                  console.debug(`Non-fatal error calling play() for stream ${stream.name}:`, err);
                });
              }

              // After 30 s with ICE connected but no video data, auto-retry
              // the entire WebRTC connection.  This recovers from go2rtc RTSP
              // source issues (camera offline, stale state, etc.) without
              // requiring the user to click Retry manually.  Mirrors the
              // existing ICE-failure auto-retry at oniceconnectionstatechange.
              // Uses a dedicated counter (noDataReconnectAttemptsRef) so that
              // the ICE-connected reset of reconnectAttemptsRef doesn't
              // inadvertently allow infinite no-data retries.
              if (
                videoDataCheckCount >= MIN_NO_DATA_CHECKS_BEFORE_RETRY &&
                (iceState === 'connected' || iceState === 'completed') &&
                !connectionRefreshRequestedRef.current &&
                noDataReconnectAttemptsRef.current < MAX_NO_DATA_RECONNECT_ATTEMPTS
              ) {
                connectionRefreshRequestedRef.current = true;
                noDataReconnectAttemptsRef.current++;
                console.log(
                  `Auto-reconnecting stream ${stream.name}: ICE connected but no video data ` +
                  `after ${videoDataCheckCount * videoDataCheckInterval / 1000}s ` +
                  `(attempt ${noDataReconnectAttemptsRef.current}/${MAX_NO_DATA_RECONNECT_ATTEMPTS})`
                );
                // Reconnect this viewer only. Refreshing the go2rtc
                // registration would drop the recording and every other
                // viewer; the manual Retry button still does that.
                setRetryCount(prev => prev + 1);
                return; // Stop check chain; the retry useEffect run starts fresh
              }

              scheduleVideoDataCheck();
            } else {
              // Exceeded 90 seconds — give up and show error
              console.error(`Stream ${stream.name} connected but no video data after ${maxVideoDataChecks * videoDataCheckInterval / 1000}s`);
              setError(t('live.streamConnectedNoVideoDataRetry'));
              setIsLoading(false);
            }
          }, videoDataCheckInterval);
        };

        scheduleVideoDataCheck();

        // Add event handlers
        videoElement.onloadedmetadata = () => {
          console.log(`Video metadata loaded for stream ${stream.name}`);
          // Clear the video data timeout since we got metadata
          if (videoDataTimeout) {
            clearTimeout(videoDataTimeout);
            videoDataTimeout = null;
          }
        };

        videoElement.onloadeddata = () => {
          console.log(`Video data loaded for stream ${stream.name}`);
        };

        videoElement.onplaying = () => {
          console.log(`Video playing for stream ${stream.name}`);
          setIsLoading(false);
          setIsPlaying(true);
          // Clear any error (e.g., if video starts playing after timeout error was shown)
          setError(null);
          // Video is genuinely playing — reset the no-data retry counter so
          // future interruptions get a fresh set of auto-reconnect attempts.
          noDataReconnectAttemptsRef.current = 0;
          // Clear timeouts since video is playing
          if (videoDataTimeout) {
            clearTimeout(videoDataTimeout);
            videoDataTimeout = null;
          }
          if (playRetryTimeout) {
            clearTimeout(playRetryTimeout);
            playRetryTimeout = null;
          }
        };

        videoElement.onwaiting = () => {
          console.log(`Video waiting for data for stream ${stream.name}`);
          // If video is waiting and paused, try to play again after a short delay
          // This handles cases where the video gets stuck in waiting state
          if (videoElement.paused && playRetryCount < maxPlayRetries) {
            console.log(`Video paused while waiting for stream ${stream.name}, scheduling retry`);
            if (playRetryTimeout) {
              clearTimeout(playRetryTimeout);
            }
            playRetryTimeout = setTimeout(attemptPlay, 300);
          }
        };

        videoElement.onstalled = () => {
          console.warn(`Video stalled for stream ${stream.name}`);
          // Try to recover from stalled state
          if (videoElement.paused && playRetryCount < maxPlayRetries) {
            console.log(`Attempting to recover from stalled state for stream ${stream.name}`);
            if (playRetryTimeout) {
              clearTimeout(playRetryTimeout);
            }
            playRetryTimeout = setTimeout(attemptPlay, 300);
          }
        };

        videoElement.onerror = (event) => {
          console.error(`Error loading video for stream ${stream.name}:`, event);
          if (videoElement.error) {
            console.error(`Video error code: ${videoElement.error.code}, message: ${videoElement.error.message}`);
          }
          setError(t('live.failedToLoadVideo'));
          setIsLoading(false);
          // Clear retry timeout on error
          if (playRetryTimeout) {
            clearTimeout(playRetryTimeout);
            playRetryTimeout = null;
          }
        };

        videoElement.ondblclick = (e) => onToggleFullscreen(stream.name, e, cellRef.current);

        // Start initial playback attempt
        attemptPlay();
      } else if (event.track.kind === 'audio') {
        console.log(`Audio track received for stream ${stream.name}`);
      }
    };

    const handleIceConnectionStateChange = () => {
      console.log(`ICE connection state for stream ${stream.name}: ${pc.iceConnectionState}`);

      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        // Connection is established or completed — start monitoring and reset counters
        // Clear any pending disconnect-recovery timeout since we've recovered
        if (disconnectRecoveryTimeoutRef.current) {
          clearTimeout(disconnectRecoveryTimeoutRef.current);
          disconnectRecoveryTimeoutRef.current = null;
        }
        startConnectionMonitoring();
        reconnectAttemptsRef.current = 0;
        if (error) {
          console.log(`WebRTC connection restored for stream ${stream.name}`);
          setError(null);
        }
      } else if (pc.iceConnectionState === 'failed') {
        console.error(`WebRTC ICE connection failed for stream ${stream.name}`);

        // Stop connection monitoring
        if (connectionMonitorRef.current) {
          clearInterval(connectionMonitorRef.current);
          connectionMonitorRef.current = null;
        }

        // Retry the connection if we haven't already for this attempt. ICE
        // failure is a network problem between this browser and go2rtc, so
        // the go2rtc registration is not refreshed: re-registering cannot fix
        // it and would drop the recording and every other viewer.
        if (!connectionRefreshRequestedRef.current && reconnectAttemptsRef.current < 3) {
          connectionRefreshRequestedRef.current = true;
          reconnectAttemptsRef.current++;
          console.log(`Retrying WebRTC connection for stream ${stream.name} (attempt ${reconnectAttemptsRef.current}/3)`);
          setTimeout(() => setRetryCount(prev => prev + 1), 800);
        } else {
          setError(t('live.webrtcIceConnectionFailed'));
          setIsLoading(false);
        }
      } else if (pc.iceConnectionState === 'disconnected') {
        // Connection is temporarily disconnected, log but don't show error yet
        console.warn(`WebRTC ICE connection disconnected for stream ${stream.name}, attempting to recover...`);

        // Stop connection monitoring while disconnected
        if (connectionMonitorRef.current) {
          clearInterval(connectionMonitorRef.current);
          connectionMonitorRef.current = null;
        }

        // Clear any existing disconnect-recovery timeout before scheduling a new one
        if (disconnectRecoveryTimeoutRef.current) {
          clearTimeout(disconnectRecoveryTimeoutRef.current);
          disconnectRecoveryTimeoutRef.current = null;
        }

        // Set a timeout to check if the connection recovers on its own
        disconnectRecoveryTimeoutRef.current = setTimeout(() => {
          // Clear the ref since this timeout is now firing
          disconnectRecoveryTimeoutRef.current = null;
          if (peerConnectionRef.current &&
              (peerConnectionRef.current.iceConnectionState === 'disconnected' ||
               peerConnectionRef.current.iceConnectionState === 'failed')) {
            console.error(`WebRTC ICE connection could not recover for stream ${stream.name}`);
            setError(t('live.webrtcConnectionLostPleaseRetry'));
            setIsLoading(false);
          } else if (peerConnectionRef.current) {
            console.log(`WebRTC ICE connection recovered for stream ${stream.name}, current state: ${peerConnectionRef.current.iceConnectionState}`);
          }
        }, 2000); // Wait 2 seconds to see if connection recovers
      } else if (pc.iceConnectionState === 'closed') {
        // Stop monitoring when closed
        if (connectionMonitorRef.current) {
          clearInterval(connectionMonitorRef.current);
          connectionMonitorRef.current = null;
        }
      }
    };

    pc.oniceconnectionstatechange = handleIceConnectionStateChange;

    // Handle ICE gathering state changes
    pc.onicegatheringstatechange = () => {
      console.log(`ICE gathering state for stream ${stream.name}: ${pc.iceGatheringState}`);
    };

    // Handle ICE candidates - critical for NAT traversal
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log(`ICE candidate for stream ${stream.name}:`, event.candidate.candidate);

        // Send the ICE candidate to the server
        // Note: go2rtc typically handles ICE candidates in the SDP exchange,
        // but we log them here for debugging purposes
        // If trickle ICE is needed, uncomment the code below:
        /*
        fetch(`/api/webrtc/ice?src=${encodeURIComponent(activeStreamSource)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(auth ? { 'Authorization': 'Basic ' + auth } : {})
          },
          body: JSON.stringify(event.candidate)
        }).catch(err => console.warn('Failed to send ICE candidate:', err));
        */
      } else {
        console.log(`ICE gathering complete for stream ${stream.name}`);
      }
    };

    // Add video transceiver
    pc.addTransceiver('video', {direction: 'recvonly'});

    // Add audio transceiver for backchannel support if enabled
    // Use sendrecv to allow both receiving audio from camera and sending audio to camera
    if (stream.backchannel_enabled) {
      console.log(`Adding audio transceiver with sendrecv for backchannel on stream ${stream.name}`);
      const audioTransceiver = pc.addTransceiver('audio', {direction: 'sendrecv'});
      // Store reference to the audio sender for later use
      audioSenderRef.current = audioTransceiver.sender;
    } else {
      // Just receive audio from the camera (if available)
      pc.addTransceiver('audio', {direction: 'recvonly'});
    }

    // Note: srcObject will be set in the ontrack event handler when we receive the remote stream

    // Connect directly to go2rtc for WebRTC
    // go2rtcBaseUrl is set at the start of initWebRTC from settings

    // Set a timeout for the entire connection process
    connectionTimeout = setTimeout(() => {
      if (peerConnectionRef.current &&
          peerConnectionRef.current.iceConnectionState !== 'connected' &&
          peerConnectionRef.current.iceConnectionState !== 'completed') {
        console.error(`WebRTC connection timeout for stream ${stream.name}, ICE state: ${peerConnectionRef.current.iceConnectionState}`);
        setError(t('live.connectionTimeoutCheckNetwork'));
        setIsLoading(false);
      }
    }, 15000); // 15 second timeout

    // Create and send offer
    pc.createOffer()
      .then(offer => {
        console.log(`Created offer for stream ${stream.name}`);
        // For debugging, log a short preview of the SDP
        if (offer && offer.sdp) {
          const preview = offer.sdp.substring(0, 120).replace(/\n/g, '\\n');
          console.log(`SDP offer preview for ${stream.name}: ${preview}...`);
        }
        return pc.setLocalDescription(offer);
      })
      .then(() => {
        console.log(`Set local description for stream ${stream.name}, waiting for ICE gathering...`);

        // Create a new AbortController for this request
        abortControllerRef.current = new AbortController();

        console.log(`Sending offer directly to go2rtc for stream ${stream.name} using source ${activeStreamSource}`);

        // Probe go2rtc quickly while the RTSP producer is warming. Long
        // exponential backoff makes a ready stream look stalled for 20s+.
        const maxOfferRetries = OFFER_RETRY_DELAYS_MS.length;
        const getOfferRetryDelay = (attempt) => OFFER_RETRY_DELAYS_MS[
          Math.min(attempt, OFFER_RETRY_DELAYS_MS.length - 1)
        ];
        const shouldRetryOfferStatus = (status) =>
          status === 404 || status === 500 || status === 502 || status === 503 || status === 504;
        const createOfferError = (message, retryable = false) => {
          const offerError = new Error(message);
          offerError.retryableOfferFailure = retryable;
          return offerError;
        };

        const sendOfferWithRetry = async (attempt) => {
          let response;
          const offerAbortController = new AbortController();
          abortControllerRef.current = offerAbortController;
          const offerTimeout = setTimeout(() => {
            offerAbortController.abort();
          }, WEBRTC_OFFER_TIMEOUT_MS);
          try {
            response = await fetch(`${go2rtcBaseUrl}/api/webrtc?src=${encodeURIComponent(activeStreamSource)}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/sdp',
              },
              body: pc.localDescription.sdp,
              signal: offerAbortController.signal,
            });
          } catch (fetchError) {
            if (attempt < maxOfferRetries) {
              const delay = getJitteredOfferRetryDelay(getOfferRetryDelay(attempt));
              console.warn(`go2rtc offer request failed for stream ${stream.name} (attempt ${attempt + 1}/${maxOfferRetries + 1}), retrying in ${delay}ms...`, fetchError);
              await new Promise(resolve => setTimeout(resolve, delay));
              return sendOfferWithRetry(attempt + 1);
            }
            fetchError.retryableOfferFailure = true;
            throw fetchError;
          } finally {
            clearTimeout(offerTimeout);
          }

          const bodyText = await response.text().catch(() => '');

          if (!response.ok) {
            // go2rtc answers 500 "codecs not matched" when the source codec
            // (e.g. an H.265 camera sub-stream) cannot be sent to this browser
            // over WebRTC. That is permanent for this source: retrying the
            // offer or refreshing the server-side registration cannot fix it,
            // and a refresh would tear down recording and every other viewer.
            if (/codecs not matched/i.test(bodyText)) {
              console.error(`go2rtc cannot send stream ${activeStreamSource} to this browser over WebRTC: ${bodyText}`);
              const codecMatch = bodyText.match(/video:(\w+)/);
              const codecError = createOfferError(
                `Camera video codec${codecMatch ? ` (${codecMatch[1]})` : ''} is not supported by this browser over WebRTC. ` +
                'Switch this camera to high quality, or set the camera sub-stream to H.264.',
                false
              );
              codecError.unsupportedCodec = true;
              throw codecError;
            }
            if (shouldRetryOfferStatus(response.status) && attempt < maxOfferRetries) {
              const delay = getJitteredOfferRetryDelay(getOfferRetryDelay(attempt));
              console.warn(`go2rtc returned ${response.status} for stream ${stream.name} (attempt ${attempt + 1}/${maxOfferRetries + 1}), retrying in ${delay}ms...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              return sendOfferWithRetry(attempt + 1);
            }
            console.error(`go2rtc /api/webrtc error for stream ${stream.name}: status=${response.status}, body="${bodyText}"`);
            // Check whether the go2rtc error body indicates the camera source is
            // unreachable (e.g. "dial tcp <ip>:554: connect: no route to host").
            // These patterns come from go2rtc's streams/add_consumer pipeline and
            // are much more actionable than a generic "500 Internal Server Error".
            const isSourceUnreachable = /dial tcp|no route to host|connection refused|connect:/i.test(bodyText);
            if (isSourceUnreachable) {
              throw new Error(t('live.cannotConnectToSource'));
            }
            const offerError = createOfferError(
              `Failed to send offer: ${response.status} ${response.statusText}`,
              shouldRetryOfferStatus(response.status)
            );
            offerError.offerStatus = response.status;
            throw offerError;
          }
          return bodyText;
        };

        return sendOfferWithRetry(0);
      })
      .then(sdpAnswer => {
        console.log(`Received SDP answer from go2rtc for stream ${stream.name}`);
        // Debug: Check if audio is in the SDP answer
        const hasAudio = sdpAnswer.includes('m=audio');
        console.log(`SDP answer contains audio: ${hasAudio} for stream ${stream.name}`);
        if (hasAudio) {
          // Find the audio section and log a snippet
          const audioIndex = sdpAnswer.indexOf('m=audio');
          console.log(`SDP audio section preview: ${sdpAnswer.substring(audioIndex, audioIndex + 200)}...`);
        }
        // go2rtc returns raw SDP, wrap it in RTCSessionDescription
        const answer = {
          type: 'answer',
          sdp: sdpAnswer
        };
        return pc.setRemoteDescription(new RTCSessionDescription(answer));
      })
      .then(() => {
        console.log(`Set remote description for stream ${stream.name}, ICE state: ${pc.iceConnectionState}`);
      })
      .catch(error => {
        console.error(`Error setting up WebRTC for stream ${stream.name}:`, error);
        clearTimeout(connectionTimeout);
        // The browser cannot play this codec: switch to an H.264 version of the
        // same stream, which the NVR converts only while it is being watched
        if (error?.unsupportedCodec && activeStreamSource === cameraStreamSource) {
          console.log(`Requesting H.264 version of ${cameraStreamSource} for this browser`);
          (async () => {
            try {
              const data = await fetchJSON(`/api/streams/${encodeURIComponent(stream.name)}/h264`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ quality: cameraStreamSource.endsWith('__low') ? 'low' : 'high' }),
                timeout: 15000,
                retries: 0
              });
              if (data?.source) {
                setH264Fallback({ from: cameraStreamSource, source: data.source });
                return;
              }
            } catch (fallbackError) {
              console.error(`Could not get an H.264 version of stream ${stream.name}:`, fallbackError);
            }
            setError(error.message || t('live.failedToEstablishWebrtcConnection'));
            setIsLoading(false);
          })();
          return;
        }
        if (
          error?.retryableOfferFailure &&
          reconnectAttemptsRef.current < MAX_OFFER_FAILURE_RECONNECT_ATTEMPTS
        ) {
          reconnectAttemptsRef.current++;
          // Only re-register when go2rtc says the stream is missing (404).
          // A refresh deletes and re-adds the stream server-side, which drops
          // the recording and every other viewer, so it must not be used for
          // failures a re-registration cannot fix.
          const needsRegistration = error.offerStatus === 404;
          console.log(
            `${needsRegistration ? 'Refreshing' : 'Retrying'} stream ${stream.name} after WebRTC offer failure ` +
            `(attempt ${reconnectAttemptsRef.current}/${MAX_OFFER_FAILURE_RECONNECT_ATTEMPTS})`
          );
          (async () => {
            try {
              if (needsRegistration) {
                await refreshStreamRegistration();
              }
              await new Promise(resolve => setTimeout(resolve, OFFER_FAILURE_REFRESH_DELAY_MS));
            } catch (refreshError) {
              console.error(`Error refreshing stream ${stream.name} after offer failure:`, refreshError);
            }
            setRetryCount(prev => prev + 1);
          })();
          return;
        }

        setError(error.message || t('live.failedToEstablishWebrtcConnection'));
        setIsLoading(false);
      });

    // Set up connection quality monitoring
    const startConnectionMonitoring = () => {
      // Clear any existing monitor
      if (connectionMonitorRef.current) {
        clearInterval(connectionMonitorRef.current);
      }
      
      // Start a new monitor
      connectionMonitorRef.current = setInterval(() => {
        if (!peerConnectionRef.current) return;
        
        // Get connection stats
        peerConnectionRef.current.getStats().then(stats => {
          let packetsLost = 0;
          let packetsReceived = 0;
          let currentRtt = 0;
          let jitter = 0;
          
          stats.forEach(report => {
            if (report.type === 'inbound-rtp' && report.kind === 'video') {
              packetsLost = report.packetsLost || 0;
              packetsReceived = report.packetsReceived || 0;
              jitter = report.jitter || 0;
            }
            
            if (report.type === 'candidate-pair' && report.state === 'succeeded') {
              currentRtt = report.currentRoundTripTime || 0;
            }
          });
          
          // Calculate packet loss percentage
          const totalPackets = packetsReceived + packetsLost;
          const lossPercentage = totalPackets > 0 ? (packetsLost / totalPackets) * 100 : 0;
          
          // Determine connection quality
          let quality = 'unknown';
          
          if (packetsReceived > 0) {
            if (
              lossPercentage < CONNECTION_QUALITY_THRESHOLDS.good.maxLossPercent &&
              currentRtt < CONNECTION_QUALITY_THRESHOLDS.good.maxRttSeconds &&
              jitter < CONNECTION_QUALITY_THRESHOLDS.good.maxJitterSeconds
            ) {
              quality = 'good';
            } else if (
              lossPercentage < CONNECTION_QUALITY_THRESHOLDS.fair.maxLossPercent &&
              currentRtt < CONNECTION_QUALITY_THRESHOLDS.fair.maxRttSeconds &&
              jitter < CONNECTION_QUALITY_THRESHOLDS.fair.maxJitterSeconds
            ) {
              quality = 'fair';
            } else if (
              lossPercentage < CONNECTION_QUALITY_THRESHOLDS.poor.maxLossPercent &&
              currentRtt < CONNECTION_QUALITY_THRESHOLDS.poor.maxRttSeconds
            ) {
              quality = 'poor';
            } else {
              quality = 'bad';
            }
          }
          
          // Update connection quality state if changed
          if (quality !== connectionQuality) {
            console.log(`WebRTC connection quality for stream ${stream.name} changed to ${quality}`);
            console.log(`Stats: loss=${lossPercentage.toFixed(2)}%, rtt=${(currentRtt * 1000).toFixed(0)}ms, jitter=${(jitter * 1000).toFixed(0)}ms`);
            setConnectionQuality(quality);
          }
        }).catch(err => {
          console.warn(`Error getting WebRTC stats for stream ${stream.name}:`, err);
        });
      }, 10000); // Check every 10 seconds
    };
    
    // Start monitoring once we have a connection
    if (peerConnectionRef.current && peerConnectionRef.current.iceConnectionState === 'connected') {
      startConnectionMonitoring();
    }
    
    }; // End of initWebRTC async function

    // Stagger initialization to avoid overwhelming go2rtc with concurrent offers
    if (initDelay > 0) {
      initDelayTimeout = setTimeout(() => {
        initDelayTimeout = null;
        initWebRTC();
      }, initDelay);
    } else {
      initWebRTC();
    }

    // Cleanup function
    const cleanupWebRTCResources = () => {
      console.log(`Cleaning up WebRTC connection for stream ${stream.name}`);
      disposed = true;

      // Clear timeouts
      if (initDelayTimeout) {
        clearTimeout(initDelayTimeout);
        initDelayTimeout = null;
      }
      if (connectionTimeout) {
        clearTimeout(connectionTimeout);
        connectionTimeout = null;
      }
      if (videoDataTimeout) {
        clearTimeout(videoDataTimeout);
        videoDataTimeout = null;
      }
      if (disconnectRecoveryTimeoutRef.current) {
        clearTimeout(disconnectRecoveryTimeoutRef.current);
        disconnectRecoveryTimeoutRef.current = null;
      }

      // Stop connection monitoring
      if (connectionMonitorRef.current) {
        clearInterval(connectionMonitorRef.current);
        connectionMonitorRef.current = null;
      }

      // Abort any pending fetch requests
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }

      // Clean up local microphone stream
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }

      // Clean up audio level monitoring
      if (audioLevelIntervalRef.current) {
        clearInterval(audioLevelIntervalRef.current);
        audioLevelIntervalRef.current = null;
      }
      if (audioContextRef.current) {
        audioContextRef.current.close().catch((err) => {
          // Log close errors to aid diagnosis of audio cleanup issues
          console.error('Failed to close AudioContext:', err);
        });
        audioContextRef.current = null;
      }
      analyserRef.current = null;

      // Clean up video element
      if (videoRef.current && videoRef.current.srcObject) {
        const tracks = videoRef.current.srcObject.getTracks();
        tracks.forEach(track => track.stop());
        videoRef.current.srcObject = null;
      }

      // Close peer connection
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }

      // Reset audio sender ref
      audioSenderRef.current = null;
    };

    return cleanupWebRTCResources;
  }, [stream?.name, retryCount, selectedStreamSource, h264Fallback]);

  /**
   * Refresh the stream's go2rtc registration
   * This is useful when WebRTC connections fail due to stale go2rtc state
   * @returns {Promise<boolean>} true if refresh was successful
   */
  const refreshStreamRegistration = async () => {
    if (!stream?.name) {
      console.warn('Cannot refresh stream: no stream name');
      return false;
    }

    try {
      console.log(`Refreshing go2rtc registration for stream ${stream.name}`);
      const response = await fetch(`/api/streams/${encodeURIComponent(stream.name)}/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`Successfully refreshed go2rtc registration for stream ${stream.name}:`, data);
        return true;
      } else {
        const errorText = await response.text();
        console.warn(`Failed to refresh stream ${stream.name}: ${response.status} - ${errorText}`);
        return false;
      }
    } catch (err) {
      console.error(`Error refreshing stream ${stream.name}:`, err);
      return false;
    }
  };

  // Handle retry button click
  const handleRetry = async () => {
    console.log(`Retry requested for stream ${stream?.name}`);

    // Clean up existing connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (videoRef.current && videoRef.current.srcObject) {
      const tracks = videoRef.current.srcObject.getTracks();
      tracks.forEach(track => track.stop());
      videoRef.current.srcObject = null;
    }

    // Reset state
    setError(null);
    setIsLoading(true);
    setIsPlaying(false);

    // Reset auto-retry counters on manual retry (user gets fresh attempts)
    reconnectAttemptsRef.current = 0;
    connectionRefreshRequestedRef.current = false;
    noDataReconnectAttemptsRef.current = 0;

    // Refresh the stream's go2rtc registration before retrying
    // This helps recover from stale go2rtc state that causes WebRTC failures
    await refreshStreamRegistration();

    // Delay to allow go2rtc to fully re-register the stream (longer for slow devices)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Increment retry count to trigger useEffect re-run
    setRetryCount(prev => prev + 1);
  };

  const { handlePauseForPrivacy, handleResumeFromPrivacy } = createPrivacyHandlers({
    stream,
    t,
    queryClient,
    setIsTogglingEnabled,
    setPrivacyActive,
    setShowPrivacyConfirm,
  });

  const handleSnapshot = () => captureVideoSnapshot({
    videoElement: videoRef.current,
    detectionOverlay: detectionOverlayRef.current,
    streamName: stream.name,
    t,
  });

  // Start audio level monitoring
  const startAudioLevelMonitoring = useCallback((localStream) => {
    try {
      // Create audio context and analyser for level monitoring
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;

      const source = audioContext.createMediaStreamSource(localStream);
      source.connect(analyser);

      audioContextRef.current = audioContext;
      analyserRef.current = analyser;

      // Start monitoring audio levels
      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      audioLevelIntervalRef.current = setInterval(() => {
        if (analyserRef.current) {
          analyserRef.current.getByteFrequencyData(dataArray);
          // Calculate average level
          const average = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          // Normalize to 0-100
          setAudioLevel(Math.min(100, Math.round((average / 128) * 100)));
        }
      }, 50);
    } catch (err) {
      console.warn('Failed to start audio level monitoring:', err);
    }
  }, []);

  // Stop audio level monitoring
  const stopAudioLevelMonitoring = useCallback(() => {
    if (audioLevelIntervalRef.current) {
      clearInterval(audioLevelIntervalRef.current);
      audioLevelIntervalRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch((err) => {
        // Log close errors to aid diagnosis of audio cleanup issues
        console.error('Failed to close AudioContext:', err);
      });
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setAudioLevel(0);
  }, []);

  // Start push-to-talk (acquire microphone and send audio)
  const startTalking = useCallback(async () => {
    if (!stream.backchannel_enabled || !audioSenderRef.current) {
      console.warn('Backchannel not enabled or audio sender not available');
      return;
    }

    try {
      setMicrophoneError(null);

      // Request microphone access
      console.log(`Requesting microphone access for backchannel on stream ${stream.name}`);
      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      localStreamRef.current = localStream;

      // Start audio level monitoring
      startAudioLevelMonitoring(localStream);

      // Get the audio track and replace the sender's track
      const audioTrack = localStream.getAudioTracks()[0];
      if (audioTrack && audioSenderRef.current) {
        await audioSenderRef.current.replaceTrack(audioTrack);
        console.log(`Started sending audio for backchannel on stream ${stream.name}`);
        setIsTalking(true);
      }
    } catch (err) {
      console.error(`Failed to start backchannel audio for stream ${stream.name}:`, err);

      if (err.name === 'NotAllowedError') {
        setMicrophoneError(t('live.microphoneAccessDenied'));
      } else if (err.name === 'NotFoundError') {
        setMicrophoneError(t('live.noMicrophoneFound'));
      } else {
        setMicrophoneError(t('live.microphoneErrorWithMessage', { message: err.message }));
      }
    }
  }, [stream, startAudioLevelMonitoring, t]);

  // Stop push-to-talk (stop sending audio)
  const stopTalking = useCallback(async () => {
    if (!stream.backchannel_enabled) return;

    try {
      // Stop audio level monitoring
      stopAudioLevelMonitoring();

      // Stop the local audio track
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
        localStreamRef.current = null;
      }

      // Replace the sender's track with null to stop sending
      if (audioSenderRef.current) {
        await audioSenderRef.current.replaceTrack(null);
        console.log(`Stopped sending audio for backchannel on stream ${stream.name}`);
      }

      setIsTalking(false);
    } catch (err) {
      console.error(`Failed to stop backchannel audio for stream ${stream.name}:`, err);
    }
  }, [stream, stopAudioLevelMonitoring]);

  // Toggle talk mode handler
  const handleTalkToggle = useCallback(() => {
    if (talkMode === 'toggle') {
      if (isTalking) {
        stopTalking();
      } else {
        startTalking();
      }
    }
  }, [talkMode, isTalking, startTalking, stopTalking]);

  // Player telemetry (TTFF, rebuffer, WebRTC RTT tracking)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream?.name) return;

    const telemetry = createPlayerTelemetry(stream.name, 'webrtc');

    const onPlaying = () => telemetry.recordFirstFrame();
    const onWaiting = () => telemetry.recordRebufferStart();
    const onCanPlay = () => telemetry.recordRebufferEnd();

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);

    // Poll WebRTC stats for RTT
    const rttInterval = setInterval(() => {
      const pc = peerConnectionRef.current;
      if (!pc) return;
      pc.getStats().then(stats => {
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.currentRoundTripTime) {
            telemetry.updateRtt(report.currentRoundTripTime * 1000); // Convert to ms
          }
        });
      }).catch(() => {});
    }, 5000);

    return () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
      clearInterval(rttInterval);
      telemetry.destroy();
    };
  }, [stream?.name]);

  return (
    <div
      className="video-cell"
      data-stream-name={stream.name}
      data-stream-id={streamId}
      data-fullscreen-timeline-arrows="seek"
      ref={cellRef}
      style={{
        position: 'relative',
        pointerEvents: 'auto',
        zIndex: 1,
        display: isFullscreenCell ? 'flex' : 'block',
        flexDirection: isFullscreenCell ? 'column' : 'row',
        minHeight: isFullscreenCell ? 0 : undefined,
        overflow: 'hidden',
        // A forced picture shape is sized against the cell (or the fullscreen stage)
        containerType: hasForcedAspect && !isFullscreenCell ? 'size' : undefined
      }}
    >
      <div
        className="fullscreen-video-stage"
        style={{
          display: isFullscreenCell ? 'block' : 'contents',
          position: isFullscreenCell ? 'relative' : undefined,
          flex: isFullscreenCell ? '1 1 auto' : undefined,
          minHeight: isFullscreenCell ? 0 : undefined,
          width: isFullscreenCell ? '100%' : undefined,
          overflow: isFullscreenCell ? 'hidden' : undefined,
          backgroundColor: isFullscreenCell ? 'black' : undefined,
          containerType: hasForcedAspect && isFullscreenCell ? 'size' : undefined
        }}
      >
        {/* Video element */}
        <video
          id={`video-${streamId.replace(/\s+/g, '-')}`}
          className="video-element"
          ref={videoRef}
          autoPlay
          muted={!audioEnabled}
          disablePictureInPicture
          playsInline
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            backgroundColor: '#000',
            position: 'absolute',
            inset: isFullscreenCell ? 0 : undefined,
            visibility: isFullscreenCell && fullscreenPlayback && isFullscreenPlaybackFrameReady ? 'hidden' : undefined,
            ...forcedVideoStyle
          }}
          onLoadedMetadata={(event) => onVideoDimensions?.(stream.name, event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
          onResize={(event) => onVideoDimensions?.(stream.name, event.currentTarget.videoWidth, event.currentTarget.videoHeight)}
        />

        <LivePreviewPoster
          streamSource={selectedStreamSource || stream.name}
          visible={!isPlaying && !fullscreenPlayback}
          delay={0}
        />

        {isFullscreenCell && fullscreenPlayback && (
          <video
            ref={setPlaybackVideoRef}
            className="video-element"
            autoPlay
            muted={!audioEnabled}
            preload="auto"
            playsInline
            disablePictureInPicture
            src={fullscreenPlayback.playbackUrl}
            poster={fullscreenPlaybackCoverFrame || fullscreenPlayback.thumbUrl || undefined}
            onEnded={handleFullscreenPlaybackEnded}
            onPlay={() => setIsFullscreenPlaybackPaused(false)}
            onPause={(event) => {
              // Reaching the end of a recording is not a pause: the next one follows
              if (!event.currentTarget.ended) setIsFullscreenPlaybackPaused(true);
            }}
            onTimeUpdate={handleFullscreenPlaybackTimeUpdate}
            onSeeked={handleFullscreenPlaybackSeeked}
            onLoadedMetadata={() => {
              applyFullscreenPlaybackSpeed(playbackVideoRef.current, fullscreenPlaybackSpeed);
            }}
            onLoadedData={() => {
              requestFullscreenPlaybackCoverRelease(playbackVideoRef.current);
            }}
            onCanPlay={() => {
              const video = playbackVideoRef.current;
              if (video) {
                applyFullscreenPlaybackSpeed(video, fullscreenPlaybackSpeed);
                requestFullscreenPlaybackCoverRelease(video);
                if (fullscreenUserPausedRef.current) return;
                video.play().catch((error) => {
                  console.debug('Fullscreen playback canplay did not resume automatically', error);
                });
              }
            }}
            onPlaying={() => {
              requestFullscreenPlaybackCoverRelease(playbackVideoRef.current);
            }}
            onClick={() => {
              const video = playbackVideoRef.current;
              if (!video) return;
              applyFullscreenPlaybackSpeed(video, fullscreenPlaybackSpeed);
              if (video.paused) {
                video.play().catch(() => {});
              } else {
                video.pause();
              }
            }}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              position: 'absolute',
              inset: 0,
              zIndex: 1,
              backgroundColor: '#000',
              opacity: isFullscreenPlaybackFrameReady ? 1 : 0,
              transition: 'opacity 80ms linear',
              ...forcedVideoStyle
            }}
          />
        )}

        {isFullscreenCell && fullscreenPlaybackCoverFrame && (
          <img
            src={fullscreenPlaybackCoverFrame}
            alt=""
            aria-hidden="true"
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              pointerEvents: 'none',
              backgroundColor: '#000'
            }}
          />
        )}
      </div>

      {/* Detection overlay component */}
      {stream.detection_based_recording && stream.detection_model && showDetections && (
        <DetectionOverlay
          ref={detectionOverlayRef}
          streamName={stream.name}
          videoRef={videoRef}
          enabled={isPlaying}
          detectionModel={stream.detection_model}
        />
      )}

      {/* Stream name overlay with connection quality indicator */}
      <StreamStatusBadge
        stream={stream}
        t={t}
        show={showLabels && !isFullscreenCell}
        className="stream-name-overlay"
        style={{
          zIndex: 3,
          gap: '8px',
        }}
        isPlaying={isPlaying}
        connectionQuality={connectionQuality}
        showConnectionQuality
      />

      {/* Stream controls */}
      {showControls && (
        <div
          className={`stream-controls ${isTimelineFullscreenControls ? 'stream-controls-fullscreen' : ''}`}
          style={{
            position: 'absolute',
            left: isTimelineFullscreenControls ? 0 : undefined,
            right: isTimelineFullscreenControls ? 0 : '10px',
            bottom: isTimelineFullscreenControls ? 'var(--fullscreen-timeline-dock-height, 0px)' : '10px',
            width: isTimelineFullscreenControls ? '100%' : undefined,
            display: 'flex',
            gap: '10px',
            justifyContent: isTimelineFullscreenControls ? 'flex-end' : undefined,
            zIndex: isTimelineFullscreenControls ? 35 : 5,
            background: isTimelineFullscreenControls
              ? 'linear-gradient(to top, rgba(0, 0, 0, 0.62), rgba(0, 0, 0, 0.18), rgba(0, 0, 0, 0))'
              : 'rgba(0, 0, 0, 0.5)',
            padding: isTimelineFullscreenControls ? '8px 16px 10px' : '5px',
            borderRadius: isTimelineFullscreenControls ? 0 : '4px'
          }}
        >
        {hasLowQuality && (
            <StreamQualitySelector
              value={tileItemQuality}
              effectiveQuality={effectiveQuality}
              onChange={handleItemQualityChange}
            />
        )}
        {showFullStreamControls && (
          <div
            className="snapshot-control"
            style={{
              backgroundColor: 'transparent',
              padding: '5px',
              borderRadius: '4px'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
              <SnapshotButton
                streamId={streamId}
                streamName={stream.name}
                onSnapshot={handleSnapshot}
              />
          </div>
        )}
        {/* Pause for privacy button */}
        {showFullStreamControls && (
        <button
          type="button"
          className="privacy-btn"
          title={t('live.pauseForPrivacy')}
          onClick={() => setShowPrivacyConfirm(true)}
          style={{
            backgroundColor: 'transparent',
            border: 'none',
            padding: '5px',
            borderRadius: '4px',
            color: 'white',
            cursor: 'pointer',
            transition: 'background-color 0.2s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18.36 6.64A9 9 0 1 1 5.64 17.36"/>
            <line x1="12" y1="2" x2="12" y2="12"/>
          </svg>
        </button>
        )}
        {/* Audio playback toggle button (for hearing camera audio) */}
        {isPlaying && (
          <button
            className={`audio-toggle-btn ${audioEnabled ? 'active' : ''}`}
            title={audioEnabled ? t('live.muteCameraAudio') : t('live.unmuteCameraAudio')}
            onClick={() => setAudioEnabled(!audioEnabled)}
            style={{
              backgroundColor: audioEnabled ? 'rgba(34, 197, 94, 0.8)' : 'transparent',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
              transition: 'background-color 0.2s ease'
            }}
            onMouseOver={(e) => !audioEnabled && (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)')}
            onMouseOut={(e) => !audioEnabled && (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            {/* Speaker icon - different icon based on muted state */}
            {audioEnabled ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <line x1="23" y1="9" x2="17" y2="15"></line>
                <line x1="17" y1="9" x2="23" y2="15"></line>
              </svg>
            )}
          </button>
        )}
        {/* Two-way audio controls for backchannel */}
        {showFullStreamControls && stream.backchannel_enabled && isPlaying && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', position: 'relative' }}>
            {/* Mode toggle button */}
            <button
              className="talk-mode-btn"
              title={talkMode === 'ptt' ? t('live.switchToToggleMode') : t('live.switchToPushToTalkMode')}
              onClick={() => setTalkMode(talkMode === 'ptt' ? 'toggle' : 'ptt')}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                padding: '3px',
                borderRadius: '4px',
                color: 'white',
                cursor: 'pointer',
                fontSize: '10px',
                opacity: 0.7
              }}
            >
              {talkMode === 'ptt' ? 'PTT' : 'TOG'}
            </button>
            {/* Main microphone button */}
            <button
              className={`ptt-btn ${isTalking ? 'talking' : ''}`}
              title={talkMode === 'ptt'
                ? (isTalking ? t('live.releaseToStopTalking') : t('live.holdToTalk'))
                : (isTalking ? t('live.clickToStopTalking') : t('live.clickToStartTalking'))}
              onMouseDown={talkMode === 'ptt' ? startTalking : undefined}
              onMouseUp={talkMode === 'ptt' ? stopTalking : undefined}
              onMouseLeave={talkMode === 'ptt' ? stopTalking : undefined}
              onTouchStart={talkMode === 'ptt' ? (e) => { e.preventDefault(); startTalking(); } : undefined}
              onTouchEnd={talkMode === 'ptt' ? (e) => { e.preventDefault(); stopTalking(); } : undefined}
              onClick={talkMode === 'toggle' ? handleTalkToggle : undefined}
              style={{
                backgroundColor: isTalking ? 'rgba(239, 68, 68, 0.8)' : 'transparent',
                border: 'none',
                padding: '5px',
                borderRadius: '4px',
                color: 'white',
                cursor: 'pointer',
                transition: 'background-color 0.2s ease',
                position: 'relative'
              }}
              onMouseOver={(e) => !isTalking && (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)')}
              onMouseOut={(e) => !isTalking && (e.currentTarget.style.backgroundColor = 'transparent')}
            >
              {/* Microphone icon */}
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill={isTalking ? 'white' : 'none'} stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" x2="12" y1="19" y2="22"></line>
              </svg>
              {/* Audio level indicator */}
              {isTalking && audioLevel > 0 && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: '-4px',
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: '20px',
                    height: '3px',
                    backgroundColor: 'rgba(0, 0, 0, 0.3)',
                    borderRadius: '2px',
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      width: `${audioLevel}%`,
                      height: '100%',
                      backgroundColor: audioLevel > 70 ? '#22c55e' : audioLevel > 30 ? '#eab308' : '#ef4444',
                      transition: 'width 0.05s ease-out'
                    }}
                  />
                </div>
              )}
            </button>
          </div>
        )}
        {/* Detection overlay toggle button */}
        {showFullStreamControls && stream.detection_based_recording && stream.detection_model && isPlaying && (
          <button
            className={`detection-toggle-btn ${showDetections ? 'active' : ''}`}
            title={showDetections ? t('live.hideDetections') : t('live.showDetections')}
            onClick={() => setLocalShowDetections(!localShowDetections)}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
              transition: 'background-color 0.2s ease'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            {showDetections ? (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                <line x1="1" y1="1" x2="23" y2="23"/>
              </svg>
            )}
          </button>
        )}
        {/* PTZ control toggle button */}
        {showFullStreamControls && stream.ptz_enabled && isPlaying && (
          <button
            className={`ptz-toggle-btn ${showPTZControls ? 'active' : ''}`}
            title={showPTZControls ? t('live.hidePtzControls') : t('live.showPtzControls')}
            onClick={() => setShowPTZControls(!showPTZControls)}
            style={{
              backgroundColor: showPTZControls ? 'rgba(59, 130, 246, 0.8)' : 'transparent',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
              transition: 'background-color 0.2s ease'
            }}
            onMouseOver={(e) => !showPTZControls && (e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)')}
            onMouseOut={(e) => !showPTZControls && (e.currentTarget.style.backgroundColor = 'transparent')}
          >
            {/* PTZ/Joystick icon */}
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
              <path d="M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
            </svg>
          </button>
        )}
        {/* Force refresh stream button - show during connecting (isLoading) or playing */}
        {showFullStreamControls && (isPlaying || isLoading) && (
          <button
            className="force-refresh-btn"
            title={t('live.forceRefreshStream')}
            onClick={() => stream?.record ? setShowRefreshConfirm(true) : handleRetry()}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              padding: '5px',
              borderRadius: '4px',
              color: 'white',
              cursor: 'pointer',
              transition: 'background-color 0.2s ease'
            }}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            {/* Refresh/reload icon */}
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
          </button>
        )}
        {showFullStreamControls && (
        <button
          type="button"
          className="timeline-btn"
          title={t('live.viewInTimeline')}
          aria-label={t('live.viewInTimeline')}
          onClick={(event) => {
            const fromFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
            forceNavigation(formatUtils.getTimelineUrl(stream.name, new Date().toISOString(), fromFullscreen), event);
          }}
          style={{
            backgroundColor: 'transparent',
            border: 'none',
            padding: '5px',
            borderRadius: '4px',
            color: 'white',
            cursor: 'pointer',
            transition: 'background-color 0.2s ease'
          }}
          onMouseOver={(event) => (event.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)')}
          onMouseOut={(event) => (event.currentTarget.style.backgroundColor = 'transparent')}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 640 640" fill="white" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M320 128C426 128 512 214 512 320C512 426 426 512 320 512C254.8 512 197.1 479.5 162.4 429.7C152.3 415.2 132.3 411.7 117.8 421.8C103.3 431.9 99.8 451.9 109.9 466.4C156.1 532.6 233 576 320 576C461.4 576 576 461.4 576 320C576 178.6 461.4 64 320 64C234.3 64 158.5 106.1 112 170.7L112 144C112 126.3 97.7 112 80 112C62.3 112 48 126.3 48 144L48 256C48 273.7 62.3 288 80 288L104.6 288C105.1 288 105.6 288 106.1 288L192.1 288C209.8 288 224.1 273.7 224.1 256C224.1 238.3 209.8 224 192.1 224L153.8 224C186.9 166.6 249 128 320 128zM344 216C344 202.7 333.3 192 320 192C306.7 192 296 202.7 296 216L296 320C296 326.4 298.5 332.5 303 337L375 409C384.4 418.4 399.6 418.4 408.9 409C418.2 399.6 418.3 384.4 408.9 375.1L343.9 310.1L343.9 216z"/>
          </svg>
        </button>
        )}
        <button
          className="fullscreen-btn"
          title={t('live.toggleFullscreen')}
          data-id={streamId}
          data-name={stream.name}
          onClick={(e) => onToggleFullscreen(stream.name, e, cellRef.current)}
          style={{
            backgroundColor: 'transparent',
            border: 'none',
            padding: '5px',
            borderRadius: '4px',
            color: 'white',
            cursor: 'pointer'
          }}
          onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.2)'}
          onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
        </button>
      </div>
      )}

      {/* Fullscreen-only timeline dock */}
      {isFullscreenCell && !error && (
        <FullscreenTimelineOverlay
          streamName={stream.name}
          isVisible={isFullscreenCell}
          mode="dock"
          playbackTimestamp={fullscreenPlaybackTimestamp}
          playbackSpeed={fullscreenPlaybackSpeed}
          onPlaybackSpeedChange={setFullscreenPlaybackSpeed}
          onPreviewSelect={handleFullscreenPreviewSelect}
          onReturnToLive={handleReturnToLive}
          playbackState={fullscreenPlaybackState}
          onTogglePause={handleFullscreenTogglePause}
        />
      )}

      {/* PTZ Controls overlay */}
      <PTZControls
        stream={stream}
        isVisible={showPTZControls && !isFullscreenCell}
        onClose={() => setShowPTZControls(false)}
      />

      {/* Microphone error indicator */}
      {microphoneError && (
        <div
          style={{
            position: 'absolute',
            bottom: '60px',
            right: '10px',
            backgroundColor: 'rgba(239, 68, 68, 0.9)',
            color: 'white',
            padding: '8px 12px',
            borderRadius: '4px',
            fontSize: '12px',
            maxWidth: '200px',
            zIndex: 6
          }}
        >
          {microphoneError}
        </div>
      )}

      {/* Loading indicator */}
      {isLoading && (
        <div
          data-testid="stream-starting-placeholder"
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 5, pointerEvents: 'none' }}
        >
          <LoadingIndicator message={t('live.streamStarting')} />
        </div>
      )}

      {/* Error indicator */}
      {error && (
        <div
          className="error-indicator"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            zIndex: 10,
            textAlign: 'center',
            pointerEvents: 'auto',
            transform: 'none'
          }}
        >
          <div
            className="error-content"
            style={{
              display: 'flex',
              flexDirection: 'column',
              justifyContent: 'center',
              alignItems: 'center',
              width: '80%',
              maxWidth: '300px',
              padding: '20px',
              borderRadius: '8px',
              backgroundColor: 'rgba(0, 0, 0, 0.5)'
            }}
          >
            <div
              className="error-icon"
              style={{
                fontSize: '28px',
                marginBottom: '15px',
                fontWeight: 'bold',
                width: '40px',
                height: '40px',
                lineHeight: '40px',
                borderRadius: '50%',
                backgroundColor: 'rgba(220, 38, 38, 0.8)',
                textAlign: 'center'
              }}
            >
              !
            </div>
            <p style={{
              marginBottom: '20px',
              textAlign: 'center',
              width: '100%',
              fontSize: '14px',
              lineHeight: '1.4'
            }}>
              {error}
            </p>
            <button
              className="retry-button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                console.log(`Retry button clicked for stream ${stream?.name}`);
                handleRetry();
              }}
              style={{
                padding: '8px 20px',
                backgroundColor: '#2563eb',
                color: 'white',
                borderRadius: '4px',
                border: 'none',
                cursor: 'pointer',
                fontWeight: 'bold',
                fontSize: '14px',
                boxShadow: '0 2px 4px rgba(0, 0, 0, 0.2)',
                transition: 'background-color 0.2s ease',
                pointerEvents: 'auto'
              }}
              onMouseOver={(e) => e.currentTarget.style.backgroundColor = '#1d4ed8'}
              onMouseOut={(e) => e.currentTarget.style.backgroundColor = '#2563eb'}
            >
              {t('common.retry')}
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        isOpen={showRefreshConfirm}
        onClose={() => setShowRefreshConfirm(false)}
        onConfirm={handleRetry}
        title={t('live.forceRefreshStream')}
        message={t('live.forceRefreshWarning')}
        confirmLabel={t('common.refresh')}
      />

      <PrivacyModeOverlays
        showPrivacyConfirm={showPrivacyConfirm}
        privacyActive={privacyActive}
        isTogglingEnabled={isTogglingEnabled}
        onPauseForPrivacy={handlePauseForPrivacy}
        onResumeFromPrivacy={handleResumeFromPrivacy}
        onCancelPause={() => setShowPrivacyConfirm(false)}
        t={t}
      />
    </div>
  );
}
