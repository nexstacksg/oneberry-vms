/**
 * Fullscreen timeline dock for live WebRTC cells.
 *
 * The dock supports two modes:
 * - `floating`: fixed to the bottom edge of the page fullscreen overlay
 * - `dock`: reserves space inside a fullscreen video cell so the timeline feels
 *   like NX Witness playback instead of a panel sitting on top of the video
 */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useQuery } from '../../query-client.js';
import { useI18n } from '../../i18n.js';
import { currentDateInputValue, getLocalDayIsoRange, shiftDateInputValue } from '../../utils/date-utils.js';
import { forceNavigation } from '../../utils/navigation-utils.js';
import { showStatusMessage } from './ToastContainer.jsx';
import { formatUtils } from './recordings/formatUtils.js';
import { TimelineBarBody } from './timeline/TimelineBarBody.jsx';
import { TimelineTrack } from './timeline/TimelineTrack.jsx';
import {
  findContainingSegmentIndex,
  findNearestSegmentIndex,
  formatTimestampAsLocalDate,
  clampTimelineValue,
  getLocalDayBounds,
  getPlayableSegmentTimestamp,
  getTimelinePreviewFrameIndex,
  getTimelineDayLengthHours,
  timestampToTimelineOffset,
  zoomTimelineRange
} from './timeline/timelineUtils.js';

function formatClockLabel(timestamp) {
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date(timestamp * 1000));
}

function formatOverlayDate(dateString) {
  if (!dateString) return '';

  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateString;

  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}

function IconButton({ title, onClick, children, active = false, disabled = false }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
        active
          ? 'border-white/20 bg-white/15 text-white'
          : 'border-white/10 bg-black/25 text-white/75 hover:bg-white/10 hover:text-white'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      {children}
    </button>
  );
}

function stripHours(hours) {
  return Math.max(hours, 0);
}

const MIN_FULLSCREEN_TIMELINE_VIEW_HOURS = 1 / 3600;
const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
const SEEK_SETTLE_TOLERANCE_SECONDS = 1.5;
// Seeking this close to now plays live, since it is not recorded yet
const LIVE_EDGE_SECONDS = 5;
// How much of the newest recording "back" plays when live is newer than any recording
const BACK_FROM_LIVE_SECONDS = 10;

function formatDurationLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '0s';
  }

  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainingSeconds = rounded % 60;
  if (minutes <= 0) {
    return `${remainingSeconds}s`;
  }
  return `${minutes}m ${remainingSeconds.toString().padStart(2, '0')}s`;
}

function formatTickLabel(offsetHours, selectedDate, stepSeconds = 3600) {
  const bounds = getLocalDayBounds(selectedDate);
  if (!bounds || !Number.isFinite(offsetHours)) {
    return '';
  }

  const timestamp = bounds.startTimestamp + (offsetHours * 3600);
  const date = new Date(timestamp * 1000);

  if (stepSeconds < 60) {
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(date);
  }

  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function MiniChevron({ expanded }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className={`h-3.5 w-3.5 transition-transform ${expanded ? '' : 'rotate-180'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/**
 * FullscreenTimelineOverlay
 * @param {Object} props
 * @param {string} props.streamName
 * @param {boolean} props.isVisible
 * @param {'floating'|'dock'} [props.mode='floating']
 * @param {number|null} [props.playbackTimestamp]
 * @param {Function} [props.onPreviewSelect]
 * @param {Function} [props.onReturnToLive]
 * @param {'live'|'live-paused'|'playing'|'paused'} [props.playbackState='live'] What the player is actually doing
 * @param {Function} [props.onTogglePause] Pause or resume the live view or the recording
 * @returns {JSX.Element|null}
 */
export function FullscreenTimelineOverlay({
  streamName,
  isVisible,
  mode = 'floating',
  playbackTimestamp = null,
  playbackSpeed = 1,
  onPlaybackSpeedChange,
  onPreviewSelect,
  onReturnToLive,
  playbackState = 'live',
  onTogglePause
}) {
  const { t } = useI18n();
  const [selectedDate, setSelectedDate] = useState(() => currentDateInputValue());
  const [clockNow, setClockNow] = useState(() => Math.floor(Date.now() / 1000));
  const [cursorTimestamp, setCursorTimestamp] = useState(() => Math.floor(Date.now() / 1000));
  const [isFollowingLive, setIsFollowingLive] = useState(true);
  const [isExpanded, setIsExpanded] = useState(true);
  const [startHour, setStartHour] = useState(0);
  const [endHour, setEndHour] = useState(() => getTimelineDayLengthHours(selectedDate));
  const [scrubTimestamp, setScrubTimestamp] = useState(null);
  const [pendingSeekTimestamp, setPendingSeekTimestamp] = useState(null);
  // A day picked in the date controls is played once that day's recordings load
  const [pendingDaySeek, setPendingDaySeek] = useState(null);
  const rootRef = useRef(null);
  const trackRef = useRef(null);
  const scrubStateRef = useRef({
    isDragging: false,
    pointerId: null,
    lastTimestamp: null,
    moved: false,
    suppressNextClick: false
  });
  const isDocked = mode === 'dock';

  useEffect(() => {
    if (!isVisible) {
      return undefined;
    }

    const root = rootRef.current;
    const host = isDocked ? root?.parentElement : document.documentElement;
    if (!root || !host) {
      return undefined;
    }

    const updateDockHeight = () => {
      host.style.setProperty('--fullscreen-timeline-dock-height', `${root.getBoundingClientRect().height}px`);
    };

    updateDockHeight();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateDockHeight);
      return () => {
        window.removeEventListener('resize', updateDockHeight);
        host.style.removeProperty('--fullscreen-timeline-dock-height');
      };
    }

    const resizeObserver = new ResizeObserver(updateDockHeight);
    resizeObserver.observe(root);

    return () => {
      resizeObserver.disconnect();
      host.style.removeProperty('--fullscreen-timeline-dock-height');
    };
  }, [isDocked, isVisible, isExpanded]);

  const dayRange = useMemo(() => getLocalDayIsoRange(selectedDate), [selectedDate]);
  const dayLengthHours = useMemo(() => getTimelineDayLengthHours(selectedDate), [selectedDate]);
  const timelineUrl = streamName
    ? `/api/timeline/segments?stream=${encodeURIComponent(streamName)}&start=${encodeURIComponent(dayRange.startTime)}&end=${encodeURIComponent(dayRange.endTime)}`
    : null;
  const motionTimelineUrl = streamName
    ? `${timelineUrl}&has_detection=1`
    : null;

  const {
    data: timelineData,
    isLoading,
    error
  } = useQuery(
    ['fullscreen-timeline-segments', streamName, selectedDate],
    timelineUrl,
    {
      timeout: 30000,
      retries: 2,
      retryDelay: 1000
    },
    {
      enabled: !!streamName && isVisible
    }
  );

  const {
    data: motionTimelineData,
    isLoading: isMotionLoading
  } = useQuery(
    ['fullscreen-motion-timeline-segments', streamName, selectedDate],
    motionTimelineUrl,
    {
      timeout: 30000,
      retries: 1,
      retryDelay: 1000
    },
    {
      enabled: !!streamName && isVisible,
      refetchInterval: 5000,
      staleTime: 0
    }
  );

  const segments = useMemo(() => {
    const rawSegments = Array.isArray(timelineData?.segments) ? timelineData.segments : [];
    return [...rawSegments].sort((a, b) => a.start_timestamp - b.start_timestamp);
  }, [timelineData]);

  const motionSegments = useMemo(() => {
    const rawSegments = Array.isArray(motionTimelineData?.segments) ? motionTimelineData.segments : [];
    return [...rawSegments].sort((a, b) => Number(b.start_timestamp) - Number(a.start_timestamp));
  }, [motionTimelineData]);

  const changeSelectedDate = (nextDate) => {
    if (!nextDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) {
      return;
    }

    const today = currentDateInputValue();
    const safeNextDate = nextDate > today ? today : nextDate;
    const currentHour = timestampToTimelineOffset(scrubTimestamp ?? cursorTimestamp, selectedDate);
    const nextDayLengthHours = getTimelineDayLengthHours(safeNextDate);
    const nextBounds = getLocalDayBounds(safeNextDate);
    const nextHour = Number.isFinite(currentHour)
      ? clampTimelineValue(currentHour, 0, nextDayLengthHours)
      : 0;

    setSelectedDate(safeNextDate);
    setStartHour(0);
    setEndHour(nextDayLengthHours);
    setScrubTimestamp(null);
    setPendingSeekTimestamp(null);
    setIsFollowingLive(false);

    if (nextBounds) {
      const nextTimestamp = Math.round(nextBounds.startTimestamp + (nextHour * 3600));
      setCursorTimestamp(nextTimestamp);
      setPendingDaySeek({ date: safeNextDate, timestamp: nextTimestamp });
    }
  };

  const shiftSelectedDate = (amount) => {
    const nextDate = shiftDateInputValue(selectedDate, amount, 'day');
    changeSelectedDate(nextDate);
  };

  const clampTimestampToSelectableRange = (timestamp, date = selectedDate) => {
    const bounds = getLocalDayBounds(date);
    if (!bounds || !Number.isFinite(timestamp)) {
      return timestamp;
    }

    const today = currentDateInputValue();
    const maxTimestamp = date >= today
      ? Math.min(bounds.endTimestamp, Math.floor(Date.now() / 1000))
      : bounds.endTimestamp;

    return Math.max(bounds.startTimestamp, Math.min(timestamp, maxTimestamp));
  };

  const updateCursorFromPointer = (event) => {
    const bounds = getLocalDayBounds(selectedDate);
    const trackElement = trackRef.current;
    if (!bounds || !trackElement) {
      return;
    }

    const rect = trackElement.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

    const visibleRange = Math.max(endHour - startHour, 0.001);
    const ratio = clampTimelineValue((event.clientX - rect.left) / rect.width, 0, 1);
    const clickHour = startHour + (ratio * visibleRange);
    const timestamp = clampTimestampToSelectableRange(Math.round(bounds.startTimestamp + (clickHour * 3600)));

    setCursorTimestamp(timestamp);
    setScrubTimestamp(timestamp);
    setPendingSeekTimestamp(null);
    scrubStateRef.current.lastTimestamp = timestamp;
    setIsFollowingLive(false);
  };

  const buildPlaybackSample = (segment, timestamp) => {
    if (!segment) {
      return null;
    }

    const segmentStart = Number(segment.start_timestamp);
    const segmentEnd = Number(segment.end_timestamp);
    if (!Number.isFinite(segmentStart) || !Number.isFinite(segmentEnd) || segmentEnd <= segmentStart) {
      return null;
    }

    const safeTimestamp = getPlayableSegmentTimestamp(segment, timestamp);
    const offsetSeconds = Math.max(0, safeTimestamp - segmentStart);

    return {
      key: `seek-${segment.id}-${safeTimestamp}`,
      timestamp: safeTimestamp,
      segmentId: segment.id,
      segmentStartTimestamp: segmentStart,
      segmentEndTimestamp: segmentEnd,
      offsetSeconds,
      thumbUrl: `/api/recordings/thumbnail/${segment.id}/${getTimelinePreviewFrameIndex(segment, safeTimestamp)}`,
      playbackUrl: `/api/recordings/play/${segment.id}?v=${safeTimestamp}`,
      href: formatUtils.getTimelineUrl(streamName, safeTimestamp, true)
    };
  };

  const resolvePlaybackSampleAtTimestamp = (timestamp) => {
    if (!segments.length) {
      return null;
    }

    const containingIndex = findContainingSegmentIndex(segments, timestamp);
    const segmentIndex = containingIndex !== -1
      ? containingIndex
      : findNearestSegmentIndex(segments, timestamp);

    if (segmentIndex === -1) {
      return null;
    }

    return buildPlaybackSample(segments[segmentIndex], timestamp);
  };

  const seekToTimestamp = (timestamp, event = null) => {
    const safeTimestamp = clampTimestampToSelectableRange(timestamp);
    const nowTimestamp = Math.floor(Date.now() / 1000);
    // Today, anything after the newest finished recording is still being
    // recorded, so the closest thing to it is live
    const newestEnd = segments.length ? Number(segments[segments.length - 1].end_timestamp) : null;
    const isAfterNewestRecording = selectedDate >= currentDateInputValue() &&
      Number.isFinite(newestEnd) && safeTimestamp > newestEnd;
    if (safeTimestamp >= nowTimestamp - LIVE_EDGE_SECONDS || isAfterNewestRecording) {
      handleLiveButton(event);
      return true;
    }

    const sample = resolvePlaybackSampleAtTimestamp(safeTimestamp);
    if (sample) {
      handlePreviewSelect(sample, event);
      return true;
    }

    // Nothing recorded there: keep playing what is on screen, and say why
    showStatusMessage(`No recording at ${formatClockLabel(safeTimestamp)}`, 'warning', 3000);
    return false;
  };

  useEffect(() => {
    // The handlers used below are declared after the hidden-overlay early return
    if (!isVisible || !pendingDaySeek || pendingDaySeek.date !== selectedDate || isLoading || !timelineData) {
      return;
    }
    setPendingDaySeek(null);
    // Play the same time of day; if nothing was recorded then, the day's first recording
    if (!resolvePlaybackSampleAtTimestamp(pendingDaySeek.timestamp) && segments.length > 0) {
      seekToTimestamp(Number(segments[0].start_timestamp));
      return;
    }
    seekToTimestamp(pendingDaySeek.timestamp);
  }, [isVisible, pendingDaySeek, selectedDate, isLoading, timelineData]);

  useEffect(() => {
    if (!isVisible || !streamName) {
      return undefined;
    }

    // Keep the live-day label aligned to the user's local midnight boundary
    // only while following live. Historical browsing should keep its date.
    const syncSelectedDate = () => {
      if (!isFollowingLive) {
        return;
      }
      const nextDate = currentDateInputValue();
      setSelectedDate(nextDate);
    };

    const midnightTick = setInterval(syncSelectedDate, 60000);
    syncSelectedDate();

    return () => clearInterval(midnightTick);
  }, [isFollowingLive, isVisible, streamName]);

  useEffect(() => {
    if (!isVisible || !streamName || !Number.isFinite(playbackTimestamp) || pendingDaySeek) {
      return;
    }

    const playbackDate = formatTimestampAsLocalDate(playbackTimestamp);
    if (playbackDate && playbackDate !== selectedDate) {
      setSelectedDate(playbackDate);
      setStartHour(0);
      setEndHour(getTimelineDayLengthHours(playbackDate));
    }

    setCursorTimestamp(playbackTimestamp);
    if (Number.isFinite(pendingSeekTimestamp) &&
        Math.abs(playbackTimestamp - pendingSeekTimestamp) <= SEEK_SETTLE_TOLERANCE_SECONDS) {
      setPendingSeekTimestamp(null);
    }
    setIsFollowingLive(false);
  }, [isVisible, pendingDaySeek, pendingSeekTimestamp, playbackTimestamp, selectedDate, streamName]);

  // Back on live from a recording (Live button, arrow keys, seeking to now): follow live again
  const previousPlaybackStateRef = useRef(playbackState);
  useEffect(() => {
    const previous = previousPlaybackStateRef.current;
    previousPlaybackStateRef.current = playbackState;
    if (!isVisible || playbackState !== 'live' || (previous !== 'playing' && previous !== 'paused')) {
      return;
    }
    const today = currentDateInputValue();
    setSelectedDate(today);
    setStartHour(0);
    setEndHour(getTimelineDayLengthHours(today));
    setCursorTimestamp(Math.floor(Date.now() / 1000));
    setPendingSeekTimestamp(null);
    setPendingDaySeek(null);
    setIsFollowingLive(true);
  }, [isVisible, playbackState]);

  useEffect(() => {
    if (!isVisible || !streamName) {
      return undefined;
    }

    const tick = () => {
      const now = Math.floor(Date.now() / 1000);
      setClockNow(now);
      if (isFollowingLive) {
        setCursorTimestamp(now);
      }
    };

    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [isVisible, streamName, isFollowingLive]);

  useEffect(() => {
    if (!isVisible || !streamName) {
      return;
    }

    setStartHour(0);
    setEndHour(dayLengthHours);
  }, [dayLengthHours, isVisible, streamName]);

  if (!isVisible || !streamName) {
    return null;
  }

  const visibleRange = Math.max(endHour - startHour, 0.001);

  const zoomIn = () => {
    const activeHour = timestampToTimelineOffset(scrubTimestamp ?? cursorTimestamp, selectedDate);
    const anchorHour = Number.isFinite(activeHour) ? activeHour : (startHour + endHour) / 2;
    const nextRange = zoomTimelineRange(startHour, endHour, 0.5, anchorHour, dayLengthHours, MIN_FULLSCREEN_TIMELINE_VIEW_HOURS);
    setStartHour(nextRange.startHour);
    setEndHour(nextRange.endHour);
  };

  const zoomOut = () => {
    const activeHour = timestampToTimelineOffset(scrubTimestamp ?? cursorTimestamp, selectedDate);
    const anchorHour = Number.isFinite(activeHour) ? activeHour : (startHour + endHour) / 2;
    const nextRange = zoomTimelineRange(startHour, endHour, 2, anchorHour, dayLengthHours, MIN_FULLSCREEN_TIMELINE_VIEW_HOURS);
    setStartHour(nextRange.startHour);
    setEndHour(nextRange.endHour);
  };

  const jumpToLive = () => {
    const now = Math.floor(Date.now() / 1000);
    const today = currentDateInputValue();
    const todayLengthHours = getTimelineDayLengthHours(today);
    setSelectedDate(today);
    setStartHour(0);
    setEndHour(todayLengthHours);
    setCursorTimestamp(now);
    setPendingSeekTimestamp(null);
    setIsFollowingLive(true);
    setIsExpanded(true);
  };

  const stepCursor = (seconds) => {
    const current = Number.isFinite(playbackTimestamp)
      ? playbackTimestamp
      : Number.isFinite(cursorTimestamp)
        ? cursorTimestamp
        : Math.floor(Date.now() / 1000);
    let next = clampTimestampToSelectableRange(Math.max(current + seconds, 0));
    // Going back from live into the minute still being recorded: play the
    // end of the newest recording rather than staying on live
    const newestEnd = segments.length ? Number(segments[segments.length - 1].end_timestamp) : null;
    if (seconds < 0 && Number.isFinite(newestEnd) && next > newestEnd) {
      next = newestEnd - Math.min(Math.abs(seconds), BACK_FROM_LIVE_SECONDS);
    }
    seekToTimestamp(next);
  };

  const handlePlayPauseButton = (event) => {
    if (typeof onTogglePause === 'function') {
      onTogglePause(event);
      return;
    }

    if (isFollowingLive) {
      setIsFollowingLive(false);
      return;
    }

    const targetTimestamp = Number.isFinite(scrubTimestamp)
      ? scrubTimestamp
      : Number.isFinite(cursorTimestamp)
        ? cursorTimestamp
        : playbackTimestamp;
    if (Number.isFinite(targetTimestamp)) {
      seekToTimestamp(targetTimestamp, event);
    }
  };

  const handleTrackPointerDown = (event) => {
    if (event.button !== 0 && event.pointerType !== 'touch') {
      return;
    }

    event.preventDefault();
    scrubStateRef.current.isDragging = true;
    scrubStateRef.current.pointerId = event.pointerId;
    scrubStateRef.current.moved = false;
    scrubStateRef.current.suppressNextClick = false;

    if (typeof event.currentTarget.setPointerCapture === 'function') {
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch (error) {
        // Ignore capture errors; scrubbing still works with direct pointer events.
      }
    }

    updateCursorFromPointer(event);
  };

  const handleTrackPointerMove = (event) => {
    if (!scrubStateRef.current.isDragging) {
      return;
    }

    event.preventDefault();
    scrubStateRef.current.moved = true;
    updateCursorFromPointer(event);
  };

  const endTrackScrub = (event) => {
    if (!scrubStateRef.current.isDragging) {
      return;
    }

    scrubStateRef.current.isDragging = false;
    scrubStateRef.current.pointerId = null;
    const finalTimestamp = scrubStateRef.current.lastTimestamp;
    const didMove = scrubStateRef.current.moved;
    scrubStateRef.current.lastTimestamp = null;
    scrubStateRef.current.moved = false;
    setScrubTimestamp(null);

    if (event?.currentTarget && typeof event.currentTarget.releasePointerCapture === 'function') {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch (error) {
        // Ignore release errors.
      }
    }

    if (didMove && Number.isFinite(finalTimestamp)) {
      scrubStateRef.current.suppressNextClick = true;
      seekToTimestamp(finalTimestamp, event);
    }
  };

  const handleStripClick = (event) => {
    if (scrubStateRef.current.suppressNextClick) {
      scrubStateRef.current.suppressNextClick = false;
      return;
    }

    const bounds = getLocalDayBounds(selectedDate);
    if (!bounds) return;

    const rect = event.currentTarget.getBoundingClientRect();
    const clickRatio = rect.width > 0
      ? Math.max(0, Math.min((event.clientX - rect.left) / rect.width, 1))
      : 0.5;
    const clickHour = startHour + (clickRatio * visibleRange);
    const timestamp = clampTimestampToSelectableRange(Math.round(bounds.startTimestamp + (clickHour * 3600)));

    seekToTimestamp(timestamp, event);
  };

  const handleWheelZoom = (event) => {
    event.preventDefault();

    const zoomFactor = event.deltaY < 0 ? 0.8 : 1.25;
    const rect = event.currentTarget.getBoundingClientRect();
    const clickRatio = rect.width > 0
      ? Math.max(0, Math.min((event.clientX - rect.left) / rect.width, 1))
      : 0.5;
    const anchorHour = startHour + (clickRatio * visibleRange);
    const nextRange = zoomTimelineRange(startHour, endHour, zoomFactor, anchorHour, dayLengthHours, MIN_FULLSCREEN_TIMELINE_VIEW_HOURS);
    setStartHour(nextRange.startHour);
    setEndHour(nextRange.endHour);
  };

  const handlePreviewSelect = (sample, event) => {
    if (!sample) return;

    const resolvedSample = sample.segment
      ? (buildPlaybackSample(sample.segment, sample.timestamp) || sample)
      : sample;

    setCursorTimestamp(resolvedSample.timestamp);
    setPendingSeekTimestamp(resolvedSample.timestamp);
    setIsFollowingLive(false);

    if (typeof onPreviewSelect === 'function') {
      onPreviewSelect(resolvedSample, event);
      return;
    }

    if (resolvedSample.href) {
      forceNavigation(resolvedSample.href, event);
    }
  };

  const handleLiveButton = (event) => {
    if (typeof onReturnToLive === 'function') {
      onReturnToLive(event);
    }

    jumpToLive();
  };

  const isPlayerRunning = playbackState === 'live' || playbackState === 'playing';
  const isRecordingPlayback = playbackState === 'playing' || playbackState === 'paused';
  const statusLabel = {
    live: 'Live',
    'live-paused': 'Live paused',
    playing: 'Playing',
    paused: 'Paused'
  }[playbackState] || 'Live';

  const currentTimeLabel = formatClockLabel(clockNow);
  const fullDateLabel = formatOverlayDate(selectedDate);
  const dateInputId = `fullscreen-timeline-date-${String(streamName).replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const todayDate = currentDateInputValue();
  const isTodaySelected = selectedDate >= todayDate;
  const activeCursorTimestamp = scrubTimestamp ?? pendingSeekTimestamp ?? playbackTimestamp ?? cursorTimestamp;
  const activeCursorHour = timestampToTimelineOffset(activeCursorTimestamp, selectedDate);
  const cursorPosition = Number.isFinite(activeCursorHour)
    ? ((activeCursorHour - startHour) / visibleRange) * 100
    : -1;
  const showCursor = cursorPosition >= 0 && cursorPosition <= 100;

  return (
    <div
      ref={rootRef}
      className={`fullscreen-timeline-overlay cursor-default text-white ${isDocked ? 'is-docked w-full' : 'border-t border-white/10 bg-[#05070d]'}`}
      style={{
        pointerEvents: 'auto',
        position: isDocked ? 'relative' : 'fixed',
        left: isDocked ? 'auto' : 0,
        right: isDocked ? 'auto' : 0,
        bottom: isDocked ? 'auto' : 0,
        zIndex: isDocked ? 20 : 1000,
        width: isDocked ? '100%' : '100vw',
        maxWidth: '100vw',
        marginTop: isDocked ? 'auto' : 0,
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)'
      }}
    >
      <div className={`flex items-center justify-center ${isDocked ? 'border-t border-white/10 bg-black/55 py-1' : 'border-b border-white/10 py-1'}`}>
        <button
          type="button"
          title={isExpanded ? 'Hide timeline' : 'Show timeline'}
          aria-label={isExpanded ? 'Hide timeline' : 'Show timeline'}
          onClick={() => setIsExpanded(v => !v)}
          className="inline-flex h-2 w-14 items-center justify-center rounded-full border border-white/10 bg-white/15 text-white/70 transition-colors hover:bg-white/25 hover:text-white"
        >
          <span className="sr-only">{isExpanded ? 'Hide timeline' : 'Show timeline'}</span>
        </button>
      </div>

      {isExpanded && (
        <div className={`fullscreen-timeline-body ${isDocked ? 'px-2 pb-1 pt-1 sm:px-3' : 'px-2 pb-2 pt-2 sm:px-3 sm:pb-3'}`}>
          <div className={isDocked
            ? 'overflow-hidden rounded-t-2xl rounded-b-none border border-white/10 bg-[#05070d]/96 shadow-[0_-24px_60px_rgba(0,0,0,0.48)]'
            : 'overflow-hidden rounded-2xl border border-white/10 bg-black/45 shadow-2xl'
          }>
            <div className={`fullscreen-timeline-toolbar flex flex-nowrap items-center justify-between gap-2 overflow-x-auto border-b border-white/10 px-2 ${isDocked ? 'bg-black/35 py-1 sm:px-3' : 'py-2 sm:px-3'}`}>
              <div className="min-w-0 flex items-center gap-3">
                <div className="min-w-0">
                  <div className={`font-mono font-semibold tabular-nums tracking-[0.12em] text-sky-200 ${isDocked ? 'text-[10px] sm:text-[11px]' : 'text-[12px] sm:text-[13px]'}`}>
                    {currentTimeLabel}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1">
                    <IconButton title="Previous day" onClick={() => shiftSelectedDate(-1)}>
                      <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m15 18-6-6 6-6" />
                      </svg>
                    </IconButton>
                    <label className="sr-only" htmlFor={dateInputId}>
                      Timeline date
                    </label>
                    <input
                      id={dateInputId}
                      type="date"
                      value={selectedDate}
                      max={todayDate}
                      onChange={(event) => changeSelectedDate(event.currentTarget.value)}
                      className={`rounded-md border border-white/10 bg-black/25 px-2 uppercase tracking-[0.08em] text-white/75 outline-none transition-colors hover:bg-white/10 focus:border-sky-300/50 focus:text-white ${isDocked ? 'h-5 text-[9px]' : 'h-7 text-[11px]'}`}
                      title={fullDateLabel}
                    />
                    <IconButton title="Next day" onClick={() => shiftSelectedDate(1)} disabled={isTodaySelected}>
                      <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </IconButton>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 flex-nowrap items-center justify-end gap-2 sm:gap-3">
                <div className="flex items-center gap-1 rounded-md border border-white/10 bg-black/25 p-1">
                  {PLAYBACK_SPEEDS.map((speed) => (
                    <button
                      key={`fullscreen-speed-${speed}`}
                      type="button"
                      title={isRecordingPlayback ? `Playback speed ${speed}x` : 'Playback speed applies to recordings'}
                      disabled={!isRecordingPlayback}
                      onClick={() => onPlaybackSpeedChange?.(speed)}
                      className={`min-w-[30px] rounded px-1 font-semibold tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isDocked ? 'h-5 text-[8px]' : 'h-6 text-[10px]'} ${
                        speed === playbackSpeed
                          ? 'bg-sky-400 text-black'
                          : 'text-white/65 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>

                <div className="hidden min-[700px]:flex items-center gap-1 rounded-md border border-white/10 bg-black/25 p-1">
                  <IconButton title="Back 5m" onClick={() => stepCursor(-300)}>
                    <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                      <path d="M6 6h2v12H6zM20 7.4 11.4 12 20 16.6V7.4zM10 7.4 1.4 12 10 16.6V7.4z" />
                    </svg>
                  </IconButton>
                  <IconButton title="Back 1m" onClick={() => stepCursor(-60)}>
                    <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                      <path d="M11 12 20 5v14l-9-7Zm-1 0 9-7v14l-9-7ZM4 5h2v14H4z" />
                    </svg>
                  </IconButton>
                  <IconButton
                    title={isPlayerRunning ? t('timeline.pause') : 'Play'}
                    active={isPlayerRunning}
                    onClick={handlePlayPauseButton}
                  >
                    {isPlayerRunning ? (
                      <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="5" width="4" height="14" rx="1" />
                        <rect x="14" y="5" width="4" height="14" rx="1" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5.1v13.8l11-6.9-11-6.9Z" />
                      </svg>
                    )}
                  </IconButton>
                  <IconButton title="Forward 1m" onClick={() => stepCursor(60)}>
                    <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                      <path d="M13 12 4 5v14l9-7Zm1 0-9-7v14l9-7ZM20 5h-2v14h2z" />
                    </svg>
                  </IconButton>
                  <IconButton title="Forward 5m" onClick={() => stepCursor(300)}>
                    <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                      <path d="M18 6h-2v12h2zM4 7.4 12.6 12 4 16.6V7.4zM14 7.4 22.6 12 14 16.6V7.4z" />
                    </svg>
                  </IconButton>
                </div>

                <IconButton
                  title={t('timeline.zoomOut')}
                  onClick={zoomOut}
                  disabled={stripHours(endHour - startHour) >= dayLengthHours}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </IconButton>
                <IconButton
                  title={t('timeline.zoomIn')}
                  onClick={zoomIn}
                  disabled={stripHours(endHour - startHour) <= MIN_FULLSCREEN_TIMELINE_VIEW_HOURS}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className={isDocked ? 'h-3 w-3' : 'h-3.5 w-3.5'} viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </IconButton>

                <button
                  type="button"
                  title={isFollowingLive ? 'Current live position' : 'Back to live'}
                  onClick={handleLiveButton}
                  className={`inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2 font-semibold uppercase tracking-[0.22em] text-white/75 transition-colors hover:bg-white/10 ${isDocked ? 'h-5 text-[8px]' : 'h-7 text-[10px]'}`}
                >
                  <span className={isDocked ? 'h-1 w-1 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(74,222,128,0.55)]' : 'h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(74,222,128,0.55)]'} />
                  LIVE
                </button>

                <div className={`hidden min-[700px]:flex items-center gap-1 rounded-full border border-sky-400/20 bg-sky-400/10 px-2 font-semibold uppercase tracking-[0.22em] text-sky-200 ${isDocked ? 'py-0 text-[8px]' : 'py-1 text-[10px]'}`}>
                  <span className={isDocked ? 'h-1 w-1 rounded-full bg-sky-300 shadow-[0_0_10px_rgba(125,211,252,0.6)]' : 'h-2 w-2 rounded-full bg-sky-300 shadow-[0_0_10px_rgba(125,211,252,0.6)]'} />
                  {statusLabel}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 min-[980px]:grid-cols-[minmax(0,1fr)_230px]">
              <div className="min-w-0">
                <TimelineBarBody
                  segments={segments}
                  selectedDate={selectedDate}
                  startHour={startHour}
                  endHour={endHour}
                  dateLabel={fullDateLabel}
                  isLoading={isLoading}
                  error={error}
                  loadingText={t('common.loading')}
                  errorText={t('timeline.reloadTimelineData')}
                  emptyText={t('recordings.noRecordingsFound')}
                  compact={isDocked}
                  onPreviewSelect={handlePreviewSelect}
                  onWheel={handleWheelZoom}
                  renderTrackContent={() => (
                    <TimelineTrack
                      segments={segments}
                      selectedDate={selectedDate}
                      startHour={startHour}
                      endHour={endHour}
                      compact={isDocked}
                      containerRef={trackRef}
                      className="cursor-pointer overflow-visible"
                      onPointerDown={handleTrackPointerDown}
                      onPointerMove={handleTrackPointerMove}
                      onPointerUp={endTrackScrub}
                      onPointerCancel={endTrackScrub}
                      onClick={handleStripClick}
                    >
                      {showCursor && (
                        <div
                          className="absolute top-[-4px] z-20"
                          style={{
                            left: `${cursorPosition}%`,
                            transform: 'translateX(-50%)'
                          }}
                        >
                          <div className={isDocked ? 'mx-auto h-2.5 w-[2px] rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.75)]' : 'mx-auto h-4 w-[2px] rounded-full bg-amber-400 shadow-[0_0_10px_rgba(251,191,36,0.75)]'} />
                          <div className={`mt-0.5 rounded-sm border border-amber-300/30 bg-amber-500/90 px-1 py-0.5 font-semibold tracking-[0.12em] text-black shadow-lg ${isDocked ? 'text-[7px]' : 'text-[9px]'}`}>
                            {formatClockLabel(activeCursorTimestamp)}
                          </div>
                        </div>
                      )}
                    </TimelineTrack>
                  )}
                  footerContent={(
                    <div className={`flex items-center justify-end gap-1.5 px-1 uppercase tracking-[0.22em] text-white/35 ${isDocked ? 'text-[8px]' : 'text-[10px]'}`}>
                      <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-white/65">Click to seek</span>
                      <span className="rounded-full border border-white/10 bg-white/5 px-1.5 py-0.5 text-white/65">
                        {statusLabel}
                      </span>
                    </div>
                  )}
                />
              </div>

              <aside className={`border-t border-white/10 bg-black/30 p-2 min-[980px]:border-l min-[980px]:border-t-0 ${isDocked ? 'min-[980px]:p-1' : ''}`}>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className={isDocked ? 'text-[9px] font-semibold uppercase tracking-[0.22em] text-white/55' : 'text-[10px] font-semibold uppercase tracking-[0.22em] text-white/55'}>Motion clips</div>
                  <div className={isDocked ? 'h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(74,222,128,0.55)]' : 'h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(74,222,128,0.55)]'} />
                </div>
                <div className={isDocked ? 'max-h-[4rem] space-y-1 overflow-y-auto pr-1' : 'max-h-[7.35rem] space-y-1 overflow-y-auto pr-1'}>
                  {isMotionLoading && motionSegments.length === 0 ? (
                    <div className={isDocked ? 'px-1.5 py-1.5 text-[9px] text-white/45' : 'px-2 py-3 text-[11px] text-white/45'}>{t('common.loading')}</div>
                  ) : motionSegments.length === 0 ? (
                    <div className={isDocked ? 'px-1.5 py-1.5 text-[9px] text-white/40' : 'px-2 py-3 text-[11px] text-white/40'}>No motion clips</div>
                  ) : (
                    motionSegments.map((segment) => (
                      <button
                        key={`motion-${segment.id}-${segment.start_timestamp}`}
                        type="button"
                        onClick={(event) => handlePreviewSelect(buildPlaybackSample(segment, segment.start_timestamp), event)}
                        className={`flex w-full items-center justify-between gap-2 rounded-md border border-white/10 bg-white/5 px-1.5 text-left transition-colors hover:border-amber-300/30 hover:bg-amber-300/10 ${isDocked ? 'py-0.5' : 'py-1.5'}`}
                      >
                        <span className={isDocked ? 'min-w-0 font-mono text-[9px] tabular-nums text-white/80' : 'min-w-0 font-mono text-[11px] tabular-nums text-white/80'}>
                          {formatClockLabel(segment.start_timestamp)}
                        </span>
                        <span className={isDocked ? 'shrink-0 text-[8px] text-white/45' : 'shrink-0 text-[10px] text-white/45'}>
                          {formatDurationLabel(Number(segment.end_timestamp) - Number(segment.start_timestamp))}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </aside>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
