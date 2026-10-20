import { useEffect, useRef, useState } from 'preact/hooks';
import {
  getStreamQualitySource,
  hasLowQualityStream,
} from '../../utils/stream-quality-utils.js';

/**
 * Live View item resolution, like Nx Witness: each tile is Auto, High or Low.
 * Auto ("adaptive scaling") uses the camera's main (high) stream when the tile
 * is the only one, shown fullscreen, or taller than 172px on screen, and the
 * sub (low) stream otherwise. A camera without a sub stream always uses main.
 */
export const ITEM_QUALITY = {
  AUTO: 'auto',
  HIGH: 'high',
  LOW: 'low',
};

export const ITEM_QUALITY_OPTIONS = [ITEM_QUALITY.AUTO, ITEM_QUALITY.HIGH, ITEM_QUALITY.LOW];

// Nx Witness switches to the high stream above 172px; a small band around it
// stops a tile near that size from flipping streams on every resize.
export const AUTO_HIGH_MIN_HEIGHT = 172;
const AUTO_HYSTERESIS = 10;

export function normalizeItemQuality(value) {
  return ITEM_QUALITY_OPTIONS.includes(value) ? value : ITEM_QUALITY.AUTO;
}

/**
 * @param {Object} options
 * @param {string} options.itemQuality      'auto' | 'high' | 'low'
 * @param {boolean} options.hasLowQuality   camera has a sub stream
 * @param {boolean} options.isOnlyItem      the only camera on the layout
 * @param {boolean} options.isFullscreen    tile shown fullscreen
 * @param {number} options.tileHeight       tile height on screen (CSS px)
 * @param {'high'|'low'} [options.previous] stream used so far (for hysteresis)
 * @returns {'high'|'low'}
 */
export function resolveItemQuality({ itemQuality, hasLowQuality, isOnlyItem, isFullscreen, tileHeight, previous }) {
  if (!hasLowQuality) return ITEM_QUALITY.HIGH;
  const quality = normalizeItemQuality(itemQuality);
  if (quality !== ITEM_QUALITY.AUTO) return quality;
  if (isOnlyItem || isFullscreen) return ITEM_QUALITY.HIGH;
  if (!(tileHeight > 0)) return previous || ITEM_QUALITY.LOW;

  const threshold = previous === ITEM_QUALITY.HIGH
    ? AUTO_HIGH_MIN_HEIGHT - AUTO_HYSTERESIS
    : AUTO_HIGH_MIN_HEIGHT + AUTO_HYSTERESIS;
  return tileHeight > threshold ? ITEM_QUALITY.HIGH : ITEM_QUALITY.LOW;
}

/**
 * Stream a Live View tile should play.
 * @param {Object} stream
 * @param {Object} options
 * @param {string} [options.itemQuality]  the tile's setting ('auto' default)
 * @param {boolean} [options.isOnlyItem]
 * @param {boolean} [options.isFullscreen]
 * @param {{current: HTMLElement|null}} options.sizeRef  element whose height is measured
 */
export function useItemQuality(stream, { itemQuality = ITEM_QUALITY.AUTO, isOnlyItem = false, isFullscreen = false, sizeRef }) {
  const hasLowQuality = hasLowQualityStream(stream);
  const [tileHeight, setTileHeight] = useState(0);
  const previousRef = useRef(null);

  useEffect(() => {
    const element = sizeRef?.current;
    if (!element) return undefined;
    const measure = () => setTileHeight(Math.round(element.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [sizeRef]);

  const effectiveQuality = resolveItemQuality({
    itemQuality,
    hasLowQuality,
    isOnlyItem,
    isFullscreen,
    tileHeight,
    previous: previousRef.current,
  });
  previousRef.current = effectiveQuality;

  return {
    hasLowQuality,
    itemQuality: normalizeItemQuality(itemQuality),
    effectiveQuality,
    selectedStreamSource: getStreamQualitySource(stream, effectiveQuality),
  };
}
