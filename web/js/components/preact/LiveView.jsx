/**
 * LightNVR Web Interface LiveView Component
 * Preact component for the HLS live view page
 */

import { useState, useEffect, useMemo, useCallback, useRef, useLayoutEffect } from 'preact/hooks';
import { showStatusMessage } from './ToastContainer.jsx';
import { useFullscreenManager, FullscreenManager, useFullscreenGridNav } from './FullscreenManager.jsx';
import { useQuery } from '../../query-client.js';
import { fetchJSON, queryClient } from '../../query-client.js';
import { SnapshotManager, useSnapshotManager } from './SnapshotManager.jsx';
import { HLSVideoCell } from './HLSVideoCell.jsx';
import { MSEVideoCell } from './MSEVideoCell.jsx';
import { WebRTCVideoCell } from './WebRTCVideoCell.jsx';
import { FullscreenTimelineOverlay } from './FullscreenTimelineOverlay.jsx';
import { isGo2rtcEnabled } from '../../utils/settings-utils.js';
import { useCameraOrder } from './useCameraOrder.js';
import { GridPicker, computeOptimalGrid, MAX_GRID_CELLS } from './GridPicker.jsx';
import { buildBuildingTree } from '../../utils/building-hierarchy.js';
import { getAuthHeaders } from '../../utils/auth-utils.js';
import { useI18n } from '../../i18n.js';

import { normalizeItemQuality } from './useItemQuality.js';
import {
  createLayoutTab,
  loadLayoutTabs,
  reconcileTabsWithLayouts,
  saveLayoutTabs,
  tabKeyAfterClose,
} from '../../utils/live-layout-tabs.js';
import { pickLiveLayoutExtras } from '../../utils/live-layout-extras.js';
import { validateSession } from '../../utils/auth-utils.js';
import {
  SCENE_MAX_SIDE,
  convertLegacyAreasToCells,
  findSceneSpot,
  findSequentialSpot,
  isAreaFree,
  normalizeSceneOrigin,
  packSequentialTiles,
  placeTileOnFreeCells,
  CELL_SPACING_OPTIONS,
  CELL_SPACING_PX,
  stepCellSpacing,
  sceneBounds,
  spanForAspect,
} from '../../utils/scene-layout.js';
import {
  CELL_ASPECT_OPTIONS,
  computeCellPadding,
  findTileAtPoint,
  getTileArrangement,
  parseAspectRatio,
  swapTilePlaces,
} from '../../utils/aspect-ratio-utils.js';

// Cell shape of the unsaved workspace (saved layouts keep their own)
const LIVE_CELL_ASPECT_STORAGE_KEY = 'lightnvr-live-cell-aspect';
const LIVE_CELL_SPACING_STORAGE_KEY = 'lightnvr-live-cell-spacing';
// Mouse wheel zoom range: below 1 shows free grid around the cameras (Nx Witness)
const SCENE_MIN_ZOOM = 0.4;
const SCENE_MAX_ZOOM = 6;
// Live View scene (Nx Witness style): tiles sit in whole cells and the scene is
// as large as they need; these are the most it may grow to in each direction.
const WORKSPACE_GRID_COLS = SCENE_MAX_SIDE;
const WORKSPACE_GRID_ROWS = SCENE_MAX_SIDE;
const DEFAULT_WORKSPACE_TILE_W = 1;
const DEFAULT_WORKSPACE_TILE_H = 1;
// Cell shape and screen shape used when tiles are arranged automatically
// (kept up to date by Live View on every render)
const sceneContext = { cellAspect: 16 / 9, viewportAspect: 16 / 9 };
const PENDING_BLANK_WORKSPACE_CAMERAS_KEY = 'oneberry.pendingBlankWorkspaceCameras';
const WORKSPACE_LAYOUT_PRESETS = [
  { count: 4, cols: 2, rows: 2, label: '2x2' },
  { count: 9, cols: 3, rows: 3, label: '3x3' },
  { count: 16, cols: 4, rows: 4, label: '4x4' },
  { count: 25, cols: 5, rows: 5, label: '5x5' },
  { count: 36, cols: 6, rows: 6, label: '6x6' },
  { count: 64, cols: 8, rows: 8, label: '8x8' },
];

const getWorkspacePresetLabel = (tiles) => {
  const safeTiles = Array.isArray(tiles) ? tiles : [];
  const slotCount = safeTiles.filter((tile) => tile.type === 'slot').length;
  const count = Math.max(slotCount, safeTiles.length);
  const matchedPreset = WORKSPACE_LAYOUT_PRESETS.find((preset) => preset.count === count);
  return matchedPreset?.label || WORKSPACE_LAYOUT_PRESETS[0].label;
};

/**
 * Convert the old single-string layout value to cols/rows for backward compat.
 * Defined as a function declaration so it hoists safely in the bundle.
 */
function legacyLayoutToColsRows(layout) {
  switch (layout) {
    case '1':  return [1, 1];
    case '2':  return [2, 1];
    case '6':  return [3, 2];
    case '9':  return [3, 3];
    case '16': return [4, 4];
    default:   return [2, 2]; // '4' and anything else → 2×2
  }
}

function getLiveInitDelay({ isWebRTC, useMSE, go2rtcAvailable, index, totalStreams }) {
  if (totalStreams <= 1) {
    return 0;
  }

  if (isWebRTC) {
    return index * 350;
  }

  if (useMSE) {
    const immediateCount = Math.min(6, totalStreams);
    if (index < immediateCount) {
      return 0;
    }
    return Math.ceil((index - immediateCount + 1) / 6) * 100;
  }

  if (go2rtcAvailable) {
    const immediateCount = Math.min(12, totalStreams);
    if (index < immediateCount) {
      return 0;
    }
    return Math.ceil((index - immediateCount + 1) / 12) * 75;
  }

  const immediateCount = Math.min(4, totalStreams);
  if (index < immediateCount) {
    return 0;
  }
  return Math.ceil((index - immediateCount + 1) / 4) * 150;
}

function getDraggedCameraNames(dataTransfer) {
  const types = Array.from(dataTransfer?.types || []);
  if (!types.includes('application/x-oneberry-camera')) return [];

  if (types.includes('application/x-oneberry-cameras')) {
    try {
      const parsed = JSON.parse(dataTransfer.getData('application/x-oneberry-cameras'));
      if (Array.isArray(parsed)) {
        const cameraNames = parsed.map((cameraName) => String(cameraName || '').trim()).filter(Boolean);
        if (cameraNames.length > 0) return cameraNames;
      }
    } catch (error) {
      // Fall back to the single-camera drag payload below.
    }
  }

  const cameraName = dataTransfer.getData('application/x-oneberry-camera') || dataTransfer.getData('text/plain');
  return cameraName ? [cameraName] : [];
}

function createWorkspaceTile(cameraId, tile = {}) {
  return {
    type: 'camera',
    // Item resolution in Live View: 'auto' (by tile size), 'high' or 'low'
    quality: normalizeItemQuality(tile.quality),
    instanceId: tile.id || `tile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    cameraId,
    x: Number.isFinite(Number(tile.x)) ? Math.max(0, Math.floor(Number(tile.x))) : 0,
    y: Number.isFinite(Number(tile.y)) ? Math.max(0, Math.floor(Number(tile.y))) : 0,
    w: Number.isFinite(Number(tile.w)) ? Math.max(1, Math.floor(Number(tile.w))) : DEFAULT_WORKSPACE_TILE_W,
    h: Number.isFinite(Number(tile.h)) ? Math.max(1, Math.floor(Number(tile.h))) : DEFAULT_WORKSPACE_TILE_H,
  };
}

function createWorkspaceSlot(tile = {}) {
  return {
    type: 'slot',
    instanceId: tile.id || `slot-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    cameraId: '',
    x: Number.isFinite(Number(tile.x)) ? Math.max(0, Math.floor(Number(tile.x))) : 0,
    y: Number.isFinite(Number(tile.y)) ? Math.max(0, Math.floor(Number(tile.y))) : 0,
    w: Number.isFinite(Number(tile.w)) ? Math.max(1, Math.floor(Number(tile.w))) : DEFAULT_WORKSPACE_TILE_W,
    h: Number.isFinite(Number(tile.h)) ? Math.max(1, Math.floor(Number(tile.h))) : DEFAULT_WORKSPACE_TILE_H,
  };
}

// The grid's area inside its padding (Live View pads it to keep the cell shape)
function getGridContentRect(grid, zoom = 1) {
  const rect = grid.getBoundingClientRect();
  const styles = window.getComputedStyle(grid);
  // Padding is in unzoomed pixels; the rect is on screen (zoomed)
  const left = (Number.parseFloat(styles.paddingLeft) || 0) * zoom;
  const right = (Number.parseFloat(styles.paddingRight) || 0) * zoom;
  const top = (Number.parseFloat(styles.paddingTop) || 0) * zoom;
  const bottom = (Number.parseFloat(styles.paddingBottom) || 0) * zoom;
  return {
    left: rect.left + left,
    top: rect.top + top,
    width: Math.max(1, rect.width - left - right),
    height: Math.max(1, rect.height - top - bottom),
  };
}

// Keep a zoomed scene covering the viewport (no empty space dragged in)
function clampSceneZoom(zoom, viewport) {
  if (!viewport || zoom.scale === 1) return { scale: 1, x: 0, y: 0 };
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (zoom.scale < 1) {
    // Zoomed out: the whole scene is centred with free grid around it
    return { scale: zoom.scale, x: (width - width * zoom.scale) / 2, y: (height - height * zoom.scale) / 2 };
  }
  return {
    scale: zoom.scale,
    x: Math.min(0, Math.max(width - width * zoom.scale, zoom.x)),
    y: Math.min(0, Math.max(height - height * zoom.scale, zoom.y)),
  };
}

function createLiveLayoutId() {
  return `layout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeLiveLayouts(data = {}) {
  return {
    layouts: Array.isArray(data.layouts)
      ? data.layouts
        .filter((layout) => layout && layout.id && layout.name)
        .map((layout) => {
          const sourceTiles = Array.isArray(layout.tiles)
            ? layout.tiles
            : (Array.isArray(layout.cameras) ? layout.cameras : []).map((camera, index) => ({
              id: `tile-${index + 1}`,
              camera,
              x: index,
              y: 0,
              w: 1,
              h: 1,
            }));
          const tiles = sourceTiles
            .map((tile, index) => {
              const camera = String(tile?.camera || tile?.cameraName || '').trim();
              if (!camera) return null;
              return {
                id: String(tile?.id || `tile-${index + 1}`).trim() || `tile-${index + 1}`,
                camera,
                quality: normalizeItemQuality(tile?.quality),
                x: Number.isFinite(Number(tile?.x)) ? Math.max(0, Math.floor(Number(tile.x))) : index,
                y: Number.isFinite(Number(tile?.y)) ? Math.max(0, Math.floor(Number(tile.y))) : 0,
                w: Number.isFinite(Number(tile?.w)) ? Math.max(1, Math.floor(Number(tile.w))) : 1,
                h: Number.isFinite(Number(tile?.h)) ? Math.max(1, Math.floor(Number(tile.h))) : 1,
              };
            })
            .filter(Boolean);
          const slots = (Array.isArray(layout.slots) ? layout.slots : [])
            .map((slot, index) => ({
              id: String(slot?.id || `slot-${index + 1}`).trim() || `slot-${index + 1}`,
              x: Number.isFinite(Number(slot?.x)) ? Math.max(0, Math.floor(Number(slot.x))) : index,
              y: Number.isFinite(Number(slot?.y)) ? Math.max(0, Math.floor(Number(slot.y))) : 0,
              w: Number.isFinite(Number(slot?.w)) ? Math.max(1, Math.floor(Number(slot.w))) : 1,
              h: Number.isFinite(Number(slot?.h)) ? Math.max(1, Math.floor(Number(slot.h))) : 1,
            }));

          return {
            // Lock, sharing and background (slots and cell shape are set below)
            ...pickLiveLayoutExtras(layout),
            id: String(layout.id),
            userId: layout.userId ?? layout.ownerUserId ?? layout.owner_user_id,
            name: String(layout.name).trim(),
            cols: Number.isFinite(Number(layout.cols)) ? Math.max(1, Math.floor(Number(layout.cols))) : undefined,
            cellAspect: CELL_ASPECT_OPTIONS.includes(layout.cellAspect) ? layout.cellAspect : 'auto',
            units: layout.units === 'cells' ? 'cells' : undefined,
            cellSpacing: CELL_SPACING_OPTIONS.includes(layout.cellSpacing) ? layout.cellSpacing : undefined,
            rows: Number.isFinite(Number(layout.rows)) ? Math.max(1, Math.floor(Number(layout.rows))) : undefined,
            tiles,
            slots,
            cameras: tiles.map((tile) => tile.camera),
          };
        })
        .filter((layout) => layout.name)
      : [],
  };
}

function tilesOverlap(a, b) {
  return (
    a.x < b.x + b.w &&
    a.x + a.w > b.x &&
    a.y < b.y + b.h &&
    a.y + a.h > b.y
  );
}

function findTileCollision(candidate, workspaceTiles, ignoredInstanceId = '') {
  return workspaceTiles.find((tile) => (
    tile.instanceId !== ignoredInstanceId && tilesOverlap(candidate, tile)
  )) || null;
}

function findOpenWorkspaceSlot(workspaceTiles, width, height, cols, rows) {
  const w = Math.max(1, Math.min(cols, width));
  const h = Math.max(1, Math.min(rows, height));
  for (let y = 0; y <= rows - h; y += 1) {
    for (let x = 0; x <= cols - w; x += 1) {
      const candidate = { x, y, w, h };
      if (!findTileCollision(candidate, workspaceTiles)) {
        return { x, y };
      }
    }
  }
  return null;
}

function buildWorkspaceOccupancyPrefix(workspaceTiles, cols, rows) {
  const safeCols = Math.max(1, cols || 1);
  const safeRows = Math.max(1, rows || 1);
  const occupied = Array.from({ length: safeRows }, () => Array(safeCols).fill(0));

  workspaceTiles.forEach((tile) => {
    const bounded = normalizeWorkspaceBounds(tile, safeCols, safeRows);
    for (let y = bounded.y; y < bounded.y + bounded.h; y += 1) {
      for (let x = bounded.x; x < bounded.x + bounded.w; x += 1) {
        occupied[y][x] = 1;
      }
    }
  });

  const prefix = Array.from({ length: safeRows + 1 }, () => Array(safeCols + 1).fill(0));
  for (let y = 0; y < safeRows; y += 1) {
    for (let x = 0; x < safeCols; x += 1) {
      prefix[y + 1][x + 1] = occupied[y][x] + prefix[y][x + 1] + prefix[y + 1][x] - prefix[y][x];
    }
  }
  return prefix;
}

function isWorkspaceRectEmpty(prefix, x, y, w, h) {
  const x2 = x + w;
  const y2 = y + h;
  return (prefix[y2][x2] - prefix[y][x2] - prefix[y2][x] + prefix[y][x]) === 0;
}

function findBestOpenWorkspaceArea(workspaceTiles, cols, rows, preferredPoint = null) {
  const safeCols = Math.max(1, cols || 1);
  const safeRows = Math.max(1, rows || 1);
  const prefix = buildWorkspaceOccupancyPrefix(workspaceTiles, safeCols, safeRows);
  const preferred = preferredPoint
    ? {
      x: Math.max(0, Math.min(safeCols - 1, Math.floor(Number(preferredPoint.x) || 0))),
      y: Math.max(0, Math.min(safeRows - 1, Math.floor(Number(preferredPoint.y) || 0))),
    }
    : null;
  const mustContainPreferred = preferred && isWorkspaceRectEmpty(prefix, preferred.x, preferred.y, 1, 1);

  let best = null;
  for (let y = 0; y < safeRows; y += 1) {
    for (let x = 0; x < safeCols; x += 1) {
      for (let h = 1; y + h <= safeRows; h += 1) {
        for (let w = 1; x + w <= safeCols; w += 1) {
          if (mustContainPreferred) {
            const containsPreferred =
              preferred.x >= x && preferred.x < x + w &&
              preferred.y >= y && preferred.y < y + h;
            if (!containsPreferred) continue;
          }
          if (!isWorkspaceRectEmpty(prefix, x, y, w, h)) continue;

          const area = w * h;
          const distance = preferred
            ? Math.abs(x + (w / 2) - preferred.x) + Math.abs(y + (h / 2) - preferred.y)
            : x + y;
          if (
            !best ||
            area > best.area ||
            (area === best.area && distance < best.distance)
          ) {
            best = { x, y, w, h, area, distance };
          }
        }
      }
    }
  }

  return best ? { x: best.x, y: best.y, w: best.w, h: best.h } : null;
}

function normalizeWorkspaceBounds(tile, cols, rows) {
  const safeCols = Math.max(1, cols || 1);
  const safeRows = Math.max(1, rows || 1);
  const w = Math.max(1, Math.min(safeCols, Math.floor(Number(tile.w) || 1)));
  const h = Math.max(1, Math.min(safeRows, Math.floor(Number(tile.h) || 1)));
  return {
    ...tile,
    w,
    h,
    x: Math.max(0, Math.min(safeCols - w, Math.floor(Number(tile.x) || 0))),
    y: Math.max(0, Math.min(safeRows - h, Math.floor(Number(tile.y) || 0))),
  };
}

function buildResponsiveWorkspaceLayout(workspaceTiles) {
  if (workspaceTiles.length === 0) return [];
  // Cameras keep the order they were added, row by row
  return packSequentialTiles(workspaceTiles.map((tile) => ({
    ...tile,
    w: Math.max(1, Math.min(SCENE_MAX_SIDE, tile.w || 1)),
    h: Math.max(1, Math.min(SCENE_MAX_SIDE, tile.h || 1)),
  })), sceneContext);
}

function buildWorkspaceInsertionCells(count, cols, rows) {
  const [layoutCols, layoutRows] = computeOptimalGrid(count);
  return Array.from({ length: count }, (_, index) => {
    const col = index % layoutCols;
    const row = Math.floor(index / layoutCols);
    const x = Math.floor((col * cols) / layoutCols);
    const y = Math.floor((row * rows) / layoutRows);
    const nextX = Math.floor(((col + 1) * cols) / layoutCols);
    const nextY = Math.floor(((row + 1) * rows) / layoutRows);
    return {
      x,
      y,
      w: Math.max(1, nextX - x),
      h: Math.max(1, nextY - y),
    };
  });
}

function getWorkspaceInsertionIndex(cells, placement) {
  if (!placement) return cells.length - 1;

  const pointX = Number(placement.x) || 0;
  const pointY = Number(placement.y) || 0;
  let bestIndex = cells.length - 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  cells.forEach((cell, index) => {
    const centerX = cell.x + (cell.w / 2);
    const centerY = cell.y + (cell.h / 2);
    const distance = Math.abs(centerX - pointX) + Math.abs(centerY - pointY);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function insertWorkspaceTileWithBalancedSpace(workspaceTiles, tile, cols, rows, placement = null) {
  const safeCols = Math.max(1, cols || 1);
  const safeRows = Math.max(1, rows || 1);
  const nextCount = Math.max(1, workspaceTiles.length + 1);
  const cells = buildWorkspaceInsertionCells(nextCount, safeCols, safeRows);
  const insertIndex = getWorkspaceInsertionIndex(cells, placement);
  const orderedTiles = workspaceTiles
    .map((workspaceTile, index) => ({ workspaceTile, index }))
    .sort((a, b) => (
      (Number(a.workspaceTile.y) || 0) - (Number(b.workspaceTile.y) || 0) ||
      (Number(a.workspaceTile.x) || 0) - (Number(b.workspaceTile.x) || 0) ||
      a.index - b.index
    ))
    .map(({ workspaceTile }) => workspaceTile);

  orderedTiles.splice(insertIndex, 0, tile);
  return orderedTiles.map((workspaceTile, index) => normalizeWorkspaceBounds({
    ...workspaceTile,
    ...cells[index],
  }, safeCols, safeRows));
}

function scaleLayoutTileToWorkspace(tile, layoutCols, layoutRows) {
  const sourceCols = Number.isFinite(Number(layoutCols)) && Number(layoutCols) > 0 ? Number(layoutCols) : WORKSPACE_GRID_COLS;
  const sourceRows = Number.isFinite(Number(layoutRows)) && Number(layoutRows) > 0 ? Number(layoutRows) : WORKSPACE_GRID_ROWS;
  if (sourceCols === WORKSPACE_GRID_COLS && sourceRows === WORKSPACE_GRID_ROWS) {
    return normalizeWorkspaceBounds(tile, WORKSPACE_GRID_COLS, WORKSPACE_GRID_ROWS);
  }

  const scaleX = WORKSPACE_GRID_COLS / sourceCols;
  const scaleY = WORKSPACE_GRID_ROWS / sourceRows;
  return normalizeWorkspaceBounds({
    ...tile,
    x: Math.round((Number(tile.x) || 0) * scaleX),
    y: Math.round((Number(tile.y) || 0) * scaleY),
    w: Math.max(DEFAULT_WORKSPACE_TILE_W, Math.round((Number(tile.w) || 1) * scaleX)),
    h: Math.max(DEFAULT_WORKSPACE_TILE_H, Math.round((Number(tile.h) || 1) * scaleY)),
  }, WORKSPACE_GRID_COLS, WORKSPACE_GRID_ROWS);
}

function serializeWorkspaceTilesForSave(workspaceTiles) {
  return workspaceTiles.filter((tile) => tile.type !== 'slot' && tile.cameraId).map((tile) => ({
    id: tile.instanceId,
    camera: tile.cameraId,
    ...(tile.quality && tile.quality !== 'auto' ? { quality: tile.quality } : {}),
    x: Number.isFinite(Number(tile.x)) ? tile.x : 0,
    y: Number.isFinite(Number(tile.y)) ? tile.y : 0,
    w: Number.isFinite(Number(tile.w)) ? tile.w : DEFAULT_WORKSPACE_TILE_W,
    h: Number.isFinite(Number(tile.h)) ? tile.h : DEFAULT_WORKSPACE_TILE_H,
  }));
}

/** One string for what a layout looks like; a different string means unsaved changes. */
function layoutPayloadKey(layoutId, cellAspect, cellSpacing, workspaceTiles) {
  return JSON.stringify({
    id: layoutId || '',
    units: 'cells',
    cellAspect,
    cellSpacing,
    tiles: serializeWorkspaceTilesForSave(workspaceTiles),
    slots: serializeWorkspaceSlotsForSave(workspaceTiles),
  });
}

function serializeWorkspaceSlotsForSave(workspaceTiles) {
  return workspaceTiles.filter((tile) => tile.type === 'slot').map((tile) => ({
    id: tile.instanceId,
    x: Number.isFinite(Number(tile.x)) ? tile.x : 0,
    y: Number.isFinite(Number(tile.y)) ? tile.y : 0,
    w: Number.isFinite(Number(tile.w)) ? tile.w : DEFAULT_WORKSPACE_TILE_W,
    h: Number.isFinite(Number(tile.h)) ? tile.h : DEFAULT_WORKSPACE_TILE_H,
  }));
}

function reflowWorkspaceTiles(workspaceTiles, cols) {
  const safeCols = Math.max(1, cols || 1);
  return workspaceTiles.map((tile, index) => ({
    ...tile,
    x: index % safeCols,
    y: Math.floor(index / safeCols),
    w: tile.w || 1,
    h: tile.h || 1,
  }));
}

function buildWorkspacePresetSlots(preset) {
  const layoutCols = Math.max(1, preset?.cols || 2);
  const count = Math.max(1, preset?.count || layoutCols * Math.max(1, preset?.rows || 1));

  // One cell per camera, like Nx Witness
  return Array.from({ length: count }, (_, index) => createWorkspaceSlot({
    id: `slot-${preset.count}-${index + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    x: index % layoutCols,
    y: Math.floor(index / layoutCols),
    w: 1,
    h: 1,
  }));
}

function LiveEmptyState({ t, title, message, actionHref, actionLabel, actionOnClick, secondaryText }) {
  return (
    <div className="live-empty-state col-span-full row-span-full">
      <div className="live-empty-visual" aria-hidden="true">
        <div className="live-empty-camera-wall">
          <span></span>
          <span></span>
          <span></span>
          <span></span>
        </div>
        <div className="live-empty-lens">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
            <rect x="3" y="6" width="12" height="12" rx="2.2" strokeWidth="1.8" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M7 10h3" />
          </svg>
        </div>
      </div>

      <div className="live-empty-content">
        <p className="live-empty-eyebrow">{t('live.liveView')}</p>
        <h3>{title}</h3>
        <p>{message}</p>
      </div>

      {actionOnClick && actionLabel ? (
        <button type="button" className="btn-primary live-empty-action" onClick={actionOnClick}>
          {actionLabel}
        </button>
      ) : actionHref && actionLabel && (
        <a href={actionHref} className="btn-primary live-empty-action">
          {actionLabel}
        </a>
      )}

      {secondaryText && (
        <p className="live-empty-secondary">{secondaryText}</p>
      )}
    </div>
  );
}

/**
 * Shared live camera grid for HLS, MSE, and WebRTC modes.
 * @returns {JSX.Element} LiveView component
 */
export function LiveView({ isWebRTCDisabled, mode = 'hls' }) {
  const { t } = useI18n();
  const isWebRTC = mode === 'webrtc';
  const storagePrefix = isWebRTC ? 'webrtc' : 'hls';
  const logLabel = isWebRTC ? 'WebRTC' : 'HLS';
  // Use the snapshot manager hook
  useSnapshotManager();

  // Use the fullscreen manager hook
  const { isFullscreen, setIsFullscreen, toggleFullscreen } = useFullscreenManager();

  // State for streams and layout
  const [streams, setStreams] = useState([]);
  const [workspaceTiles, setWorkspaceTiles] = useState([]);
  const [workspaceStarted, setWorkspaceStarted] = useState(true);
  const [workspaceAutoGrid, setWorkspaceAutoGrid] = useState(true);
  // Shape of the layout's cells, like Nx Witness: 'auto' follows the first camera
  const [layoutCellAspect, setLayoutCellAspect] = useState(() => {
    try {
      const stored = localStorage.getItem(LIVE_CELL_ASPECT_STORAGE_KEY);
      return CELL_ASPECT_OPTIONS.includes(stored) ? stored : 'auto';
    } catch {
      return 'auto';
    }
  });
  // Space between cameras (Nx Witness "Cell Spacing"; Ctrl + mouse wheel)
  const [layoutCellSpacing, setLayoutCellSpacing] = useState(() => {
    try {
      const stored = localStorage.getItem(LIVE_CELL_SPACING_STORAGE_KEY);
      return CELL_SPACING_OPTIONS.includes(stored) ? stored : 'medium';
    } catch {
      return 'medium';
    }
  });
  // Grid lines drawn over the whole view while a camera is moved or resized
  const [gridOverlay, setGridOverlay] = useState(null);
  // Picture shape each camera actually sends, reported by the video cells
  const [videoAspectByCamera, setVideoAspectByCamera] = useState({});
  // Item resolution per camera for the classic grid (layout tiles keep their own)
  const [classicItemQuality, setClassicItemQuality] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('lightnvr-live-item-quality') || '{}') || {};
    } catch {
      return {};
    }
  });
  const [isAdminUser, setIsAdminUser] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareUsers, setShareUsers] = useState([]);
  const [shareSelection, setShareSelection] = useState([]);
  const backgroundInputRef = useRef(null);
  // Tile being dragged, and the tile or empty slot it would swap with
  const [movingTileId, setMovingTileId] = useState('');
  // Selected cameras in the layout (click, Ctrl+click, Ctrl+A) and the right-click menu
  const [selectedTileIds, setSelectedTileIds] = useState([]);
  const [tileContextMenu, setTileContextMenu] = useState(null);
  const lastPointerDraggedRef = useRef(false);
  const [selectionBox, setSelectionBox] = useState(null);
  const selectedTileIdsRef = useRef([]);
  selectedTileIdsRef.current = selectedTileIds;
  const [resizingTileId, setResizingTileId] = useState('');
  // Cells a dragged/resized tile will snap to when released
  const [snapPreview, setSnapPreview] = useState(null);
  // Cameras a resize will move aside (dimmed until release)
  // Where tiles were on screen just before a change, so they can glide to their new place
  const flipFromRef = useRef(null);
  // Scene zoom and pan (mouse wheel / drag on empty space), like Nx Witness
  const [sceneZoom, setSceneZoom] = useState({ scale: 1, x: 0, y: 0 });
  const sceneZoomRef = useRef(sceneZoom);
  sceneZoomRef.current = sceneZoom;
  const sceneViewportRef = useRef(null);
  const [tileDropTargetId, setTileDropTargetId] = useState('');
  const [activeLayoutId, setActiveLayoutId] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const layoutParam = p.get('layout');
    if (layoutParam === 'none' || layoutParam === 'workspace') {
      return '';
    }
    return layoutParam || localStorage.getItem(`lightnvr-${storagePrefix}-last-layout`) || '';
  });
  const [singleCameraView, setSingleCameraView] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const layoutParam = p.get('layout');
    const cameraParam = p.get('camera');
    if (!layoutParam || layoutParam === 'none' || layoutParam === 'workspace' || !cameraParam) {
      return null;
    }
    return {
      selectedLayoutId: layoutParam,
      selectedCameraId: cameraParam,
      previousLayoutState: null,
    };
  });
  const [hydratedLayoutId, setHydratedLayoutId] = useState('');
  const saveLayoutTimeoutRef = useRef(null);
  const workspaceGridRef = useRef(null);
  const workspacePointerRef = useRef(null);
  const workspaceTilesRef = useRef([]);
  const cameraSpanRef = useRef(() => ({ w: 1, h: 1 }));
  const getCameraAspectRef = useRef(() => null);
  const workspaceLockedRef = useRef(false);
  const wheelSpacingAtRef = useRef(0);
  const workspaceAutoExpandedDropRef = useRef(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [layoutPresetMenuOpen, setLayoutPresetMenuOpen] = useState(false);
  // Layout tabs (Nx Witness style); changes stay a draft until saved
  const [currentUsername, setCurrentUsername] = useState(null);
  const [layoutTabs, setLayoutTabs] = useState([]);
  const [activeTabKey, setActiveTabKey] = useState('');
  const [tabsReady, setTabsReady] = useState(false);
  const initialSearchRef = useRef(typeof window !== 'undefined' ? window.location.search : '');
  // What the open layout looked like when it was opened or last saved
  const [savedPayloadKey, setSavedPayloadKey] = useState('');
  const [tabContextMenu, setTabContextMenu] = useState(null);
  const [closeTabPrompt, setCloseTabPrompt] = useState(null);
  const [urlStreamHydrated, setUrlStreamHydrated] = useState(false);
  const [removingTileIds, setRemovingTileIds] = useState(new Set());
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const removeTimeoutsRef = useRef(new Map());

  useEffect(() => {
    const mediaQuery = window.matchMedia('(max-width: 768px)');
    const updateMobileViewport = () => setIsMobileViewport(mediaQuery.matches);

    updateMobileViewport();
    mediaQuery.addEventListener?.('change', updateMobileViewport);
    mediaQuery.addListener?.(updateMobileViewport);

    return () => {
      mediaQuery.removeEventListener?.('change', updateMobileViewport);
      mediaQuery.removeListener?.(updateMobileViewport);
    };
  }, []);

  // Tag filter: '' means "All"
  const [tagFilter, setTagFilter] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get('tag') || localStorage.getItem(`lightnvr-${storagePrefix}-tag-filter`) || '';
  });

  // State for toggling stream labels and controls visibility
  const [showLabels, setShowLabels] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const u = p.get('labels');
    if (u !== null) return u !== '0';
    // Camera names are off by default (v2 key: earlier versions stored "on" for everyone)
    const stored = localStorage.getItem('lightnvr-show-labels-v2');
    return stored === 'true';
  });
  const [showControls, setShowControls] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    const u = p.get('controls');
    if (u !== null) return u !== '0';
    const stored = localStorage.getItem('lightnvr-show-controls');
    return stored !== null ? stored === 'true' : true;
  });
  // Global detection overlay toggle (persisted to localStorage)
  const [showDetections, setShowDetections] = useState(() => {
    const stored = localStorage.getItem('lightnvr-show-detections');
    return stored !== null ? stored === 'true' : true;
  });
  const [isLoading, setIsLoading] = useState(true);

  // State for go2rtc availability
  const [go2rtcAvailable, setGo2rtcAvailable] = useState(false);

  // State for go2rtc mode - determines whether to use MSE or HLS
  // Initialize from URL param if present
  const [useMSE, setUseMSE] = useState(() => {
    if (isWebRTC) return false;
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get('mode') === 'mse';
  });

  // Initialize cols/rows from URL params, shared localStorage key, or legacy per-view keys.
  // All live views (WebRTC / HLS / MSE) share 'lightnvr-live-cols' / 'lightnvr-live-rows'
  // so a layout change on one page carries over to the others.
  // autoGrid stays true when no preference exists — streams-load effect will
  // auto-size the grid to fit the available camera count.
  const [autoGrid, setAutoGrid] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return p.get('cols') === null
      && localStorage.getItem('lightnvr-live-cols') === null
      && localStorage.getItem(`lightnvr-${storagePrefix}-cols`) === null
      && localStorage.getItem(`lightnvr-${storagePrefix}-layout`) === null;
  });
  const [cols, setCols] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const cp = urlParams.get('cols');
    if (cp) return Math.max(1, Math.min(9, parseInt(cp, 10) || 2));
    const shared = localStorage.getItem('lightnvr-live-cols');
    if (shared) return Math.max(1, Math.min(9, parseInt(shared, 10) || 2));
    const legacy = localStorage.getItem(`lightnvr-${storagePrefix}-cols`);
    if (legacy) return Math.max(1, Math.min(9, parseInt(legacy, 10) || 2));
    const oldLayout = localStorage.getItem(`lightnvr-${storagePrefix}-layout`);
    if (oldLayout) return legacyLayoutToColsRows(oldLayout)[0];
    return 2; // placeholder until autoGrid resolves
  });
  const [rows, setRows] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const rp = urlParams.get('rows');
    if (rp) return Math.max(1, Math.min(9, parseInt(rp, 10) || 2));
    const shared = localStorage.getItem('lightnvr-live-rows');
    if (shared) return Math.max(1, Math.min(9, parseInt(shared, 10) || 2));
    const legacy = localStorage.getItem(`lightnvr-${storagePrefix}-rows`);
    if (legacy) return Math.max(1, Math.min(9, parseInt(legacy, 10) || 2));
    const oldLayout = localStorage.getItem(`lightnvr-${storagePrefix}-layout`);
    if (oldLayout) return legacyLayoutToColsRows(oldLayout)[1];
    return 2; // placeholder until autoGrid resolves
  });

  // Total streams per page — derived immediately so URL-sync useEffect can reference
  // isSingleStream in its dependency array without TDZ issues.
  const maxStreams = cols * rows;
  // The scene is as big as its tiles; while a tile is resized it gets one spare
  // column and row so it can grow (moving keeps the grid still under the pointer)
  const sceneSize = sceneBounds(workspaceTiles);
  const sceneGrowRoom = 0;
  const workspaceGridCols = workspaceStarted ? Math.min(SCENE_MAX_SIDE, sceneSize.cols + sceneGrowRoom) : cols;
  const workspaceGridRows = workspaceStarted ? Math.min(SCENE_MAX_SIDE, sceneSize.rows + sceneGrowRoom) : rows;
  const gridDimsRef = useRef({ cols: workspaceGridCols, rows: workspaceGridRows });
  gridDimsRef.current = { cols: workspaceGridCols, rows: workspaceGridRows };

  // Clamp cols×rows to MAX_GRID_CELLS — guards against stale URL params or
  // localStorage values written before the 64-stream cap was enforced.
  useEffect(() => {
    if (cols * rows > MAX_GRID_CELLS) {
      setRows(Math.max(1, Math.floor(MAX_GRID_CELLS / cols)));
    }
  }, [cols, rows]);

  // True when we're in single-stream mode
  const isSingleStream = maxStreams === 1;
  const singleCameraMode = Boolean(
    singleCameraView?.selectedLayoutId &&
    singleCameraView?.selectedCameraId &&
    singleCameraView.selectedLayoutId === activeLayoutId
  );

  // Initialize selectedStream from URL or sessionStorage if available
  const [selectedStream, setSelectedStream] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const streamParam = urlParams.get('stream');
    if (streamParam) {
      return streamParam;
    }
    // Check sessionStorage as a backup
    const storedStream = sessionStorage.getItem(`${storagePrefix}_selected_stream`);
    return storedStream || '';
  });

  // Initialize currentPage from URL or sessionStorage if available (URL uses 1-based indexing, internal state uses 0-based)
  const [currentPage, setCurrentPage] = useState(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const pageParam = urlParams.get('page');
    if (pageParam) {
      // Convert from 1-based (URL) to 0-based (internal)
      return Math.max(0, parseInt(pageParam, 10) - 1);
    }
    // Check sessionStorage as a backup
    const storedPage = sessionStorage.getItem(`${storagePrefix}_current_page`);
    if (storedPage) {
      // Convert from 1-based (stored) to 0-based (internal)
      return Math.max(0, parseInt(storedPage, 10) - 1);
    }
    return 0;
  });

  // Check if go2rtc is enabled (for showing mode toggle)
  useEffect(() => {
    const checkGo2rtcMode = async () => {
      try {
        const go2rtcEnabled = await isGo2rtcEnabled();
        console.log(`[${logLabel}View] go2rtc enabled: ${go2rtcEnabled}`);
        setGo2rtcAvailable(go2rtcEnabled);
        // If user requested MSE via URL but go2rtc is not enabled, fall back to HLS
        if (!isWebRTC && useMSE && !go2rtcEnabled) {
          console.log('[LiveView] MSE requested but go2rtc not enabled, falling back to HLS');
          setUseMSE(false);
        }
      } catch (error) {
        console.error(`[${logLabel}View] Error checking go2rtc status:`, error);
        setGo2rtcAvailable(false);
        if (!isWebRTC) setUseMSE(false);
      }
    };
    checkGo2rtcMode();
  }, [isWebRTC, logLabel, useMSE]);

  // Fetch streams using preact-query, and periodically refresh so stream
  // status (Running / Reconnecting / Stopped etc.) stays up-to-date.
  const {
    data: streamsData,
    isLoading: isLoadingStreams,
    error: streamsError
  } = useQuery(
    'streams',
    '/api/streams',
    {
      timeout: 15000, // 15 second timeout
      retries: 2,     // Retry twice
      retryDelay: 1000 // 1 second between retries
    },
    isWebRTC ? {} : {
      refetchInterval: 30000 // Re-poll stream list (and status) every 30 s
    }
  );

  const {
    data: locationCatalog = { buildings: [] }
  } = useQuery(
    ['locations'],
    '/api/locations',
    {
      timeout: 10000,
      retries: 1,
      retryDelay: 1000
    }
  );

  const {
    data: liveLayoutsData = { layouts: [] },
    isSuccess: liveLayoutsLoaded,
  } = useQuery(
    ['live-layouts'],
    '/api/live-layouts',
    {
      headers: getAuthHeaders(),
      timeout: 10000,
      retries: 1,
      retryDelay: 1000
    },
    {
      refetchInterval: 30000
    }
  );

  // Per-camera display settings (forced picture shape)
  const { data: cameraDisplayData } = useQuery(
    ['camera-display'],
    '/api/camera-display',
    {
      timeout: 10000,
      retries: 1,
      retryDelay: 1000
    },
    {
      refetchInterval: 60000
    }
  );
  const cameraDisplay = cameraDisplayData?.cameras || {};

  // Most cameras one layout may hold (Settings > Web Interface; Nx Witness default 64)
  const { data: liveSettingsData } = useQuery(
    ['settings'],
    '/api/settings',
    {
      timeout: 10000,
      retries: 1,
      retryDelay: 1000
    }
  );
  const layoutMaxItems = Math.max(1, Number(liveSettingsData?.live_layout_max_items) || 64);
  const layoutMaxItemsRef = useRef(layoutMaxItems);
  layoutMaxItemsRef.current = layoutMaxItems;
  useEffect(() => {
    let cancelled = false;
    validateSession().then((session) => {
      if (!cancelled) {
        setIsAdminUser(session?.role === 'admin');
        setCurrentUsername(session?.username || '');
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const showLayoutFullMessage = () => showStatusMessage(
    `A layout can hold at most ${layoutMaxItemsRef.current} cameras. An admin can change this in Settings (Cameras per layout).`,
    'error',
    6000
  );

  const setTileItemQuality = useCallback((tileInstanceId, cameraName, quality) => {
    const nextQuality = normalizeItemQuality(quality);
    if (tileInstanceId) {
      setWorkspaceTiles((previousTiles) => previousTiles.map((tile) => (
        tile.instanceId === tileInstanceId ? { ...tile, quality: nextQuality } : tile
      )));
      return;
    }
    setClassicItemQuality((previous) => {
      const next = { ...previous, [cameraName]: nextQuality };
      try {
        localStorage.setItem('lightnvr-live-item-quality', JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  const handleVideoDimensions = useCallback((cameraName, width, height) => {
    if (!cameraName || !(width > 0) || !(height > 0)) return;
    const aspect = width / height;
    setVideoAspectByCamera((previous) => (
      Math.abs((previous[cameraName] || 0) - aspect) < 0.01 ? previous : { ...previous, [cameraName]: aspect }
    ));
  }, []);

  // Update loading state based on streams query status
  useEffect(() => {
    setIsLoading(isLoadingStreams);
  }, [isLoadingStreams]);

  // Process streams data when it's loaded
  useEffect(() => {
    if (streamsData && Array.isArray(streamsData)) {
      // Process the streams data
      const processStreams = async () => {
        try {
          const filteredStreams = await filterStreamsForLiveView(streamsData);

          if (filteredStreams.length > 0) {
            setStreams(filteredStreams);

            // Auto-size the grid to fit the stream count when no preference is stored
            if (autoGrid) {
              const [optCols, optRows] = computeOptimalGrid(filteredStreams.length);
              setCols(optCols);
              setRows(optRows);
              setAutoGrid(false);
            }

            // Set selectedStream based on URL parameter if it exists and is valid
            const urlParams = new URLSearchParams(window.location.search);
            const streamParam = urlParams.get('stream');

            if (!activeLayoutId && streamParam && filteredStreams.some(stream => stream.name === streamParam)) {
              // If the stream from URL exists in the loaded streams, use it
              setSelectedStream(streamParam);
              if (!urlStreamHydrated) {
                setWorkspaceTiles(buildResponsiveWorkspaceLayout([createWorkspaceTile(streamParam)]));
                setWorkspaceStarted(true);
                setWorkspaceAutoGrid(true);
                setUrlStreamHydrated(true);
              }
            } else if (!selectedStream || !filteredStreams.some(stream => stream.name === selectedStream)) {
              // Otherwise use the first stream if selectedStream is not set or invalid
              setSelectedStream(filteredStreams[0].name);
            }
          } else {
            console.warn(`No streams available for ${logLabel} view after filtering`);
          }
        } catch (error) {
          console.error('Error processing streams:', error);
          showStatusMessage(t('live.errorProcessingStreams', { message: error.message }));
        }
      };

      processStreams();
    }
    // Note: We intentionally only re-run when streamsData changes
    // selectedStream is read but we don't want to trigger refetch when it changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamsData, autoGrid, activeLayoutId]);

  // Sync layout/page/stream to URL — only meaningful once streams are loaded.
  useEffect(() => {
    if (streams.length === 0) return;

    const url = new URL(window.location);

    // Page (1-based in URL, omit on first page)
    if (currentPage === 0) url.searchParams.delete('page');
    else url.searchParams.set('page', currentPage + 1);

    // cols/rows — omit from URL when at the default (2×2)
    if (cols !== 2 || rows !== 2) {
      url.searchParams.set('cols', cols);
      url.searchParams.set('rows', rows);
    } else {
      url.searchParams.delete('cols');
      url.searchParams.delete('rows');
    }
    url.searchParams.delete('layout'); // remove legacy param

    if (activeLayoutId) {
      url.searchParams.set('layout', activeLayoutId);
      url.searchParams.delete('stream');
      if (singleCameraMode && singleCameraView?.selectedCameraId) {
        url.searchParams.set('camera', singleCameraView.selectedCameraId);
      } else {
        url.searchParams.delete('camera');
      }
    } else {
      url.searchParams.delete('layout');
      url.searchParams.delete('camera');
      // Stream selection (single-stream mode only)
      if (isSingleStream && selectedStream) url.searchParams.set('stream', selectedStream);
      else url.searchParams.delete('stream');
    }

    window.history.replaceState({}, '', url);

    // Persist to storage
    if (currentPage > 0) sessionStorage.setItem(`${storagePrefix}_current_page`, (currentPage + 1).toString());
    else sessionStorage.removeItem(`${storagePrefix}_current_page`);
    localStorage.setItem('lightnvr-live-cols', String(cols));
    localStorage.setItem('lightnvr-live-rows', String(rows));
    // Clean up old per-view keys so reads don't fall back to stale values
    localStorage.removeItem(`lightnvr-${storagePrefix}-cols`);
    localStorage.removeItem(`lightnvr-${storagePrefix}-rows`);
    localStorage.removeItem(`lightnvr-${storagePrefix}-layout`);
    if (!activeLayoutId && isSingleStream && selectedStream) sessionStorage.setItem(`${storagePrefix}_selected_stream`, selectedStream);
    else sessionStorage.removeItem(`${storagePrefix}_selected_stream`);
  }, [activeLayoutId, currentPage, cols, rows, isSingleStream, selectedStream, singleCameraMode, singleCameraView?.selectedCameraId, streams.length]);

  // Sync UI preference controls (group, labels, controls) to URL and localStorage.
  // Runs independently of streams-loaded state so the URL is always accurate.
  useEffect(() => {
    const url = new URL(window.location);

    if (tagFilter) url.searchParams.set('tag', tagFilter);
    else url.searchParams.delete('tag');

    // Omit params when at their defaults (true) to keep URL clean
    if (!showLabels) url.searchParams.set('labels', '0');
    else url.searchParams.delete('labels');

    if (!showControls) url.searchParams.set('controls', '0');
    else url.searchParams.delete('controls');

    window.history.replaceState({}, '', url);

    // Persist to localStorage for sessions without URL
    if (tagFilter) localStorage.setItem(`lightnvr-${storagePrefix}-tag-filter`, tagFilter);
    else localStorage.removeItem(`lightnvr-${storagePrefix}-tag-filter`);
    localStorage.setItem('lightnvr-show-labels-v2', String(showLabels));
    localStorage.setItem('lightnvr-show-controls', String(showControls));
    localStorage.setItem('lightnvr-show-detections', String(showDetections));
  }, [tagFilter, showLabels, showControls, showDetections, storagePrefix]);

  const filterStreamsForLiveView = async (sourceStreams) => {
    try {
      if (!sourceStreams || !Array.isArray(sourceStreams)) {
        console.warn('No streams data provided to filter');
        return [];
      }

      const filteredStreams = sourceStreams.filter(stream => {
        if (stream.is_deleted) {
          console.log(`Stream ${stream.name} is soft deleted, filtering out`);
          return false;
        }
        if (!stream.enabled) {
          console.log(`Stream ${stream.name} is administratively disabled, filtering out`);
          return false;
        }
        if (!stream.streaming_enabled) {
          console.log(`Stream ${stream.name} is not configured for streaming, filtering out`);
          return false;
        }
        return true;
      });

      console.log(`Filtered streams for ${logLabel} view:`, filteredStreams);
      return filteredStreams;
    } catch (error) {
      console.error(`Error filtering streams for ${logLabel} view:`, error);
      showStatusMessage(t('live.errorProcessingStreams', { message: error.message }));
      return [];
    }
  };

  const streamByName = useMemo(() => (
    new Map(streams.map((stream) => [stream.name, stream]))
  ), [streams]);
  const liveLayouts = useMemo(() => normalizeLiveLayouts(liveLayoutsData), [liveLayoutsData]);
  const activeLayout = useMemo(() => (
    activeLayoutId
      ? liveLayouts.layouts.find((layout) => layout.id === activeLayoutId) || null
      : null
  ), [activeLayoutId, liveLayouts]);
  // Shared with me by someone else: read-only. Locked by its owner: no editing until unlocked.
  const isSharedLayout = Boolean(activeLayout?.sharedWithMe);
  const isLockedLayout = Boolean(activeLayout?.locked);
  // Layouts can be changed any time (changes are a draft until saved), except
  // a locked layout, one shared by someone else, or the single camera view
  const workspaceLocked = singleCameraMode || (Boolean(activeLayoutId) && (isSharedLayout || isLockedLayout));
  workspaceLockedRef.current = workspaceLocked;
  const lockedReasonRef = useRef('');
  lockedReasonRef.current = singleCameraMode
    ? 'Go back to the layout to change it'
    : isSharedLayout
      ? 'This layout is shared with you (view only). Use Save As to make your own copy.'
      : 'This layout is locked. Unlock it to make changes.';
  const showLockedLayoutMessage = () => showStatusMessage(lockedReasonRef.current, 'error', 5000);

  const captureCurrentLayoutState = useCallback(() => ({
    selectedLayoutId: activeLayoutId,
    workspaceTiles,
    workspaceAutoGrid,
    currentPage,
    hydratedLayoutId,
  }), [activeLayoutId, currentPage, hydratedLayoutId, workspaceAutoGrid, workspaceTiles]);

  const exitSingleCameraView = useCallback((layoutId = '') => {
    const previousLayoutState = singleCameraView?.previousLayoutState || null;
    const targetLayoutId = String(layoutId || previousLayoutState?.selectedLayoutId || '').trim();

    setSingleCameraView(null);
    if (targetLayoutId) {
      setActiveLayoutId(targetLayoutId);
    }

    if (previousLayoutState && (!targetLayoutId || previousLayoutState.selectedLayoutId === targetLayoutId)) {
      setWorkspaceTiles(previousLayoutState.workspaceTiles);
      setWorkspaceAutoGrid(previousLayoutState.workspaceAutoGrid);
      setHydratedLayoutId(previousLayoutState.hydratedLayoutId);
      setCurrentPage(previousLayoutState.currentPage);
    } else {
      setCurrentPage(0);
    }
  }, [singleCameraView]);

  const enterSingleCameraView = useCallback((layoutId, cameraId) => {
    const selectedLayoutId = String(layoutId || '').trim();
    const selectedCameraId = String(cameraId || '').trim();
    if (!selectedLayoutId || !selectedCameraId) return;

    setSingleCameraView((previousView) => {
      if (
        previousView?.selectedLayoutId === selectedLayoutId &&
        previousView?.selectedCameraId === selectedCameraId
      ) {
        return previousView;
      }

      return {
        selectedLayoutId,
        selectedCameraId,
        previousLayoutState: previousView?.previousLayoutState || captureCurrentLayoutState(),
      };
    });
    setActiveLayoutId((previousLayoutId) => {
      if (previousLayoutId === selectedLayoutId) return previousLayoutId;
      setHydratedLayoutId('');
      return selectedLayoutId;
    });
    setWorkspaceStarted(true);
    setWorkspaceAutoGrid(false);
    setLayoutPresetMenuOpen(false);
    setWorkspaceMenuOpen(false);
    setCurrentPage(0);
  }, [captureCurrentLayoutState]);

  const saveLiveLayouts = useCallback(async (nextLayouts, previousLayouts = liveLayouts) => {
    const normalized = normalizeLiveLayouts(nextLayouts);
    queryClient.setQueryData(['live-layouts'], normalized);

    try {
      const saved = await fetchJSON('/api/live-layouts', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify(normalized),
        timeout: 10000,
        retries: 1,
        retryDelay: 1000,
      });
      const savedLayouts = normalizeLiveLayouts(saved);
      queryClient.setQueryData(['live-layouts'], savedLayouts);
      return savedLayouts;
    } catch (error) {
      queryClient.setQueryData(['live-layouts'], previousLayouts);
      showStatusMessage(error.message || 'Failed to save layouts', 'error', 8000);
      throw error;
    }
  }, [liveLayouts]);

  useEffect(() => {
    if (!activeLayoutId) {
      localStorage.removeItem(`lightnvr-${storagePrefix}-last-layout`);
      return;
    }
    localStorage.setItem(`lightnvr-${storagePrefix}-last-layout`, activeLayoutId);
  }, [activeLayoutId, storagePrefix]);

  useEffect(() => {
    if (!activeLayoutId || isLoadingStreams || liveLayouts.layouts.length === 0) return;
    if (activeLayout) return;
    setSingleCameraView(null);
    setActiveLayoutId('');
    setHydratedLayoutId('');
    setSavedPayloadKey('');
  }, [activeLayout, activeLayoutId, isLoadingStreams, liveLayouts.layouts.length]);

  useEffect(() => {
    if (!singleCameraView?.selectedLayoutId) return;
    const layout = liveLayouts.layouts.find((candidate) => candidate.id === singleCameraView.selectedLayoutId);
    if (!layout) {
      setSingleCameraView(null);
      return;
    }

    const hasCamera = layout.tiles.some((tile) => tile.camera === singleCameraView.selectedCameraId);
    if (!hasCamera) {
      setSingleCameraView(null);
    }
  }, [liveLayouts.layouts, singleCameraView?.selectedCameraId, singleCameraView?.selectedLayoutId]);

  useEffect(() => {
    if (!activeLayoutId || !activeLayout || streams.length === 0 || hydratedLayoutId === activeLayoutId) return;

    const rawTiles = activeLayout.tiles
      .filter((tile) => streamByName.has(tile.camera))
      .map((tile, index) => createWorkspaceTile(tile.camera, {
        ...tile,
        id: tile.id || `tile-${index + 1}`,
      }));
    const rawSlots = (activeLayout.slots || []).map((slot, index) => createWorkspaceSlot({
      ...slot,
      id: slot.id || `slot-${index + 1}`,
    }));
    // Layouts saved before the scene used whole cells are converted on open
    const areas = activeLayout.units === 'cells'
      ? normalizeSceneOrigin([...rawTiles, ...rawSlots])
      : convertLegacyAreasToCells([...rawTiles, ...rawSlots]);
    const tiles = areas.filter((area) => area.type !== 'slot');
    const slots = areas.filter((area) => area.type === 'slot');

    setWorkspaceTiles([...tiles, ...slots]);
    setWorkspaceStarted(true);
    setWorkspaceAutoGrid(tiles.length === 0 && slots.length === 0);
    setLayoutCellAspect(activeLayout.cellAspect || 'auto');
    setLayoutCellSpacing(activeLayout.cellSpacing || 'medium');
    setCurrentPage(0);

    setSavedPayloadKey(layoutPayloadKey(activeLayout.id, activeLayout.cellAspect || 'auto', activeLayout.cellSpacing || 'medium', [...tiles, ...slots]));
    setHydratedLayoutId(activeLayoutId);
  }, [activeLayout, activeLayoutId, hydratedLayoutId, streamByName, streams.length]);

  // ---- Layout tabs ---------------------------------------------------------
  // The open tab is what Live View shows; other tabs keep their unsaved changes
  // (draft) until they are opened again. Nothing is saved until the user saves.
  const activeLayoutPayloadKey = useMemo(() => (
    layoutPayloadKey(activeLayoutId, layoutCellAspect, layoutCellSpacing, workspaceTiles)
  ), [activeLayoutId, layoutCellAspect, layoutCellSpacing, workspaceTiles]);
  const isActiveDraft = activeLayoutId
    ? hydratedLayoutId === activeLayoutId && Boolean(savedPayloadKey) && activeLayoutPayloadKey !== savedPayloadKey
    : workspaceTiles.length > 0;
  const activeTab = layoutTabs.find((tab) => tab.key === activeTabKey) || null;
  const activeTabTitleRef = useRef('');
  activeTabTitleRef.current = activeTab && !activeTab.layoutId ? activeTab.title : '';

  // Unsaved changes of the open tab, as kept in its tab
  const currentTabDraft = () => (isActiveDraft ? {
    tiles: workspaceTiles,
    cellAspect: layoutCellAspect,
    cellSpacing: layoutCellSpacing,
    autoGrid: workspaceAutoGrid,
    baseline: activeLayoutId ? savedPayloadKey : '',
  } : null);

  const tabStateRef = useRef({});
  tabStateRef.current = {
    layoutTabs,
    activeTabKey,
    activeLayoutId,
    isDraft: isActiveDraft,
    singleCameraView,
    draft: currentTabDraft,
  };

  // The open tab with its latest changes, ready to be put away
  function tabsWithCurrentDraft() {
    const state = tabStateRef.current;
    if (state.singleCameraView) return state.layoutTabs;
    return state.layoutTabs.map((tab) => (
      tab.key === state.activeTabKey
        ? { ...tab, layoutId: state.activeLayoutId || '', draft: state.draft() }
        : tab
    ));
  }

  // Show a tab: its draft if it has one, otherwise the saved layout
  function showTabContents(tab) {
    setSingleCameraView(null);
    setSelectedTileIds([]);
    setTileContextMenu(null);
    setCurrentPage(0);
    setWorkspaceStarted(true);
    captureTileRects();
    if (tab.draft) {
      setActiveLayoutId(tab.layoutId || '');
      setWorkspaceTiles(tab.draft.tiles || []);
      setLayoutCellAspect(tab.draft.cellAspect || 'auto');
      setLayoutCellSpacing(tab.draft.cellSpacing || 'medium');
      setWorkspaceAutoGrid(Boolean(tab.draft.autoGrid));
      setSavedPayloadKey(tab.draft.baseline || '');
      setHydratedLayoutId(tab.layoutId || '');
    } else if (tab.layoutId) {
      setActiveLayoutId(tab.layoutId);
      setWorkspaceTiles([]);
      setSavedPayloadKey('');
      // Loads the saved layout
      setHydratedLayoutId('');
    } else {
      setActiveLayoutId('');
      setWorkspaceTiles([]);
      setWorkspaceAutoGrid(true);
      setSavedPayloadKey('');
      setHydratedLayoutId('');
    }
  }

  function switchToLayoutTab(key, tabs = null) {
    const state = tabStateRef.current;
    const nextTabs = tabs || tabsWithCurrentDraft();
    const target = nextTabs.find((tab) => tab.key === key);
    if (!target) return;
    setLayoutTabs(nextTabs);
    if (key === state.activeTabKey && !tabs) return;
    setActiveTabKey(key);
    showTabContents(target);
  }

  function openNewLayoutTab() {
    const tabs = tabsWithCurrentDraft();
    const tab = createLayoutTab('', tabs);
    switchToLayoutTab(tab.key, [...tabs, tab]);
  }

  // Before a blank layout is filled with cameras: use the open tab if it is an
  // empty new layout, otherwise a new tab
  function prepareNewLayoutTab() {
    const state = tabStateRef.current;
    const current = state.layoutTabs.find((tab) => tab.key === state.activeTabKey);
    if (!current || (!state.activeLayoutId && !state.isDraft)) return;
    const tabs = tabsWithCurrentDraft();
    const tab = createLayoutTab('', tabs);
    setLayoutTabs([...tabs, tab]);
    setActiveTabKey(tab.key);
  }

  // A saved layout opens in its own tab (Nx Witness); if it is open already,
  // that tab is shown. An empty new-layout tab is reused.
  function openLayoutInTab(layoutId) {
    const state = tabStateRef.current;
    const tabs = tabsWithCurrentDraft();
    const existing = tabs.find((tab) => tab.layoutId === layoutId);
    if (existing) {
      switchToLayoutTab(existing.key, tabs);
      return;
    }
    const current = tabs.find((tab) => tab.key === state.activeTabKey);
    if (current && !current.layoutId && !current.draft) {
      const reused = { ...current, layoutId, title: '', draft: null };
      switchToLayoutTab(reused.key, tabs.map((tab) => (tab.key === reused.key ? reused : tab)));
      return;
    }
    const tab = createLayoutTab(layoutId, tabs);
    switchToLayoutTab(tab.key, [...tabs, tab]);
  }

  function closeLayoutTab(key, { force = false } = {}) {
    const tabs = tabsWithCurrentDraft();
    const closing = tabs.find((tab) => tab.key === key);
    if (!closing) return;
    if (!force && closing.draft) {
      // Unsaved changes: ask first (Save / Don't Save / Cancel)
      if (key !== tabStateRef.current.activeTabKey) switchToLayoutTab(key, tabs);
      setCloseTabPrompt({ key });
      return;
    }
    const nextActive = tabKeyAfterClose(tabs, key, tabStateRef.current.activeTabKey);
    let remaining = tabs.filter((tab) => tab.key !== key);
    if (remaining.length === 0) {
      // There is always one tab
      remaining = [createLayoutTab('', [])];
    }
    const nextKey = remaining.some((tab) => tab.key === nextActive) ? nextActive : remaining[0].key;
    if (nextKey === tabStateRef.current.activeTabKey) {
      setLayoutTabs(remaining);
    } else {
      switchToLayoutTab(nextKey, remaining);
    }
  }

  function discardActiveTabChanges() {
    const state = tabStateRef.current;
    const tabs = state.layoutTabs.map((tab) => (
      tab.key === state.activeTabKey ? { ...tab, layoutId: state.activeLayoutId || '', draft: null } : tab
    ));
    const tab = tabs.find((candidate) => candidate.key === state.activeTabKey);
    setLayoutTabs(tabs);
    if (tab) showTabContents(tab);
  }

  // Open tabs come back from this browser once we know who is signed in
  useEffect(() => {
    if (tabsReady || currentUsername === null || !liveLayoutsLoaded) return;
    const layoutIds = liveLayouts.layouts.map((layout) => layout.id);
    const stored = loadLayoutTabs(currentUsername);
    let tabs = reconcileTabsWithLayouts(stored?.tabs || [], layoutIds);
    // The address as it was when the page opened (it is tidied up while loading)
    const urlParams = new URLSearchParams(initialSearchRef.current);
    const urlLayout = urlParams.get('layout') || '';
    // ?stream=<camera> shows that camera in a new layout (it is already on screen)
    const urlCamera = !urlLayout ? (urlParams.get('stream') || '') : '';
    const wantsNewLayout = urlLayout === 'workspace' || urlLayout === 'none' || Boolean(urlCamera);
    const wantedLayoutId = !wantsNewLayout && layoutIds.includes(activeLayoutId) ? activeLayoutId : '';
    let active = null;
    if (wantedLayoutId) {
      active = tabs.find((tab) => tab.layoutId === wantedLayoutId) || null;
      if (!active) {
        active = createLayoutTab(wantedLayoutId, tabs);
        tabs = [...tabs, active];
      }
    } else if (wantsNewLayout) {
      active = tabs.find((tab) => !tab.layoutId && !tab.draft) || null;
      if (!active) {
        active = createLayoutTab('', tabs);
        tabs = [...tabs, active];
      }
    } else {
      active = tabs.find((tab) => tab.key === stored?.activeKey) || tabs[0] || null;
    }
    if (!active) {
      active = createLayoutTab('', tabs);
      tabs = [...tabs, active];
    }
    setLayoutTabs(tabs);
    setActiveTabKey(active.key);
    // Show the tab unless Live View already shows exactly that: the saved
    // layout, or the camera asked for in the URL
    if (!urlCamera && (active.draft || (active.layoutId || '') !== (activeLayoutId || '') || !active.layoutId)) {
      showTabContents(active);
    }
    setTabsReady(true);
  }, [currentUsername, liveLayoutsLoaded, liveLayouts, tabsReady]);

  // Keep the open tab pointing at the layout it shows (e.g. after Save As)
  useEffect(() => {
    if (!tabsReady || singleCameraView) return;
    setLayoutTabs((tabs) => {
      let changed = false;
      const next = tabs.map((tab) => {
        if (tab.key !== activeTabKey || (tab.layoutId || '') === (activeLayoutId || '')) return tab;
        changed = true;
        return { ...tab, layoutId: activeLayoutId || '', title: activeLayoutId ? '' : (tab.title || 'New Layout') };
      });
      return changed ? next : tabs;
    });
  }, [activeLayoutId, activeTabKey, singleCameraView, tabsReady]);

  // Layouts deleted elsewhere (or no longer shared) lose their tabs
  useEffect(() => {
    if (!tabsReady || !liveLayoutsLoaded) return;
    const layoutIds = liveLayouts.layouts.map((layout) => layout.id);
    const tabs = tabsWithCurrentDraft();
    const next = reconcileTabsWithLayouts(tabs, layoutIds);
    if (next.length === tabs.length && next.every((tab, index) => tab.layoutId === tabs[index].layoutId)) return;
    if (next.length === 0) next.push(createLayoutTab('', []));
    const activeStill = next.find((tab) => tab.key === activeTabKey);
    if (activeStill) {
      setLayoutTabs(next);
      if ((activeStill.layoutId || '') !== (activeLayoutId || '')) showTabContents(activeStill);
    } else {
      switchToLayoutTab(next[0].key, next);
    }
  }, [liveLayouts, liveLayoutsLoaded, tabsReady]);

  // Tabs and drafts are kept in this browser (they survive a reload)
  useEffect(() => {
    if (!tabsReady || currentUsername === null) return undefined;
    const timeoutId = window.setTimeout(() => {
      saveLayoutTabs(currentUsername, tabsWithCurrentDraft(), activeTabKey);
    }, 250);
    return () => window.clearTimeout(timeoutId);
  }, [activeLayoutPayloadKey, activeTabKey, currentUsername, isActiveDraft, layoutTabs, savedPayloadKey, tabsReady, workspaceAutoGrid]);

  // Ctrl+S saves the open layout
  useEffect(() => {
    const handleKeyDown = (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      saveActiveTabRef.current?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  const saveActiveTabRef = useRef(null);

  const captureTileRects = useCallback(() => {
    const grid = workspaceGridRef.current;
    if (!grid) return;
    const rects = {};
    grid.querySelectorAll('[data-tile-id]').forEach((element) => {
      rects[element.dataset.tileId] = element.getBoundingClientRect();
    });
    flipFromRef.current = rects;
  }, []);

  const getWorkspaceGridPoint = useCallback((event) => {
    const grid = workspaceGridRef.current;
    const { cols: gridCols, rows: gridRows } = gridDimsRef.current;
    if (!grid) return { x: 0, y: 0 };
    const rect = getGridContentRect(grid, sceneZoomRef.current.scale);
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * gridCols);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * gridRows);
    return {
      x: Math.max(0, Math.min(gridCols - 1, x)),
      y: Math.max(0, Math.min(gridRows - 1, y)),
    };
  }, []);

  const updateWorkspaceTile = useCallback((instanceId, updater) => {
    setWorkspaceTiles((previousTiles) => {
      const currentTile = previousTiles.find((tile) => tile.instanceId === instanceId);
      if (!currentTile) return previousTiles;

      const proposedTile = normalizeWorkspaceBounds(
        typeof updater === 'function' ? updater(currentTile) : { ...currentTile, ...updater },
        SCENE_MAX_SIDE,
        SCENE_MAX_SIDE
      );
      const collision = findTileCollision(proposedTile, previousTiles, instanceId);

      if (!collision) {
        return previousTiles.map((tile) => (
          tile.instanceId === instanceId ? proposedTile : tile
        ));
      }

      if (proposedTile.w === collision.w && proposedTile.h === collision.h) {
        return previousTiles.map((tile) => {
          if (tile.instanceId === instanceId) return { ...proposedTile, x: collision.x, y: collision.y };
          if (tile.instanceId === collision.instanceId) return { ...collision, x: currentTile.x, y: currentTile.y };
          return tile;
        });
      }

      return previousTiles;
    });
  }, []);

  const addWorkspaceTile = useCallback((cameraName, placement = null, options = {}) => {
    const cameraId = String(cameraName || '').trim();
    if (!cameraId) return;

    if (workspaceLocked && !options.force) {
      showLockedLayoutMessage();
      return;
    }

    if (!streamByName.has(cameraId)) {
      showStatusMessage(`Camera "${cameraId}" is not available in Live View`, 'error', 5000);
      return;
    }

    const shouldAutoTile = !activeLayoutId && !placement && options.autoFit !== false;
    workspaceAutoExpandedDropRef.current = false;
    captureTileRects();
    setWorkspaceStarted(true);
    setWorkspaceTiles((previousTiles) => {
      const cameraTileCount = previousTiles.filter((tile) => tile.type !== 'slot' && tile.cameraId).length;
      if (cameraTileCount >= layoutMaxItemsRef.current) {
        window.setTimeout(showLayoutFullMessage, 0);
        return previousTiles;
      }
      // Cells shaped like the camera's picture (Nx Witness style)
      const span = cameraSpanRef.current(cameraId, previousTiles);
      const candidateTile = createWorkspaceTile(cameraId, { w: span.w, h: span.h });
      const targetSlot = previousTiles.find((tile) => {
        if (tile.type !== 'slot') return false;
        if (!placement) return true;
        return (
          placement.x >= tile.x &&
          placement.x < tile.x + tile.w &&
          placement.y >= tile.y &&
          placement.y < tile.y + tile.h
        );
      });
      if (targetSlot) {
        return previousTiles.map((tile) => (
          tile.instanceId === targetSlot.instanceId
            ? { ...candidateTile, x: targetSlot.x, y: targetSlot.y, w: targetSlot.w, h: targetSlot.h }
            : tile
        ));
      }

      if (shouldAutoTile || (!placement && workspaceAutoGrid && options.autoFit !== false)) {
        return buildResponsiveWorkspaceLayout([...previousTiles, candidateTile]);
      }

      const spot = placement && isAreaFree(previousTiles, placement.x, placement.y, span.w, span.h)
        ? placement
        : placement
          ? findSceneSpot(previousTiles, span.w, span.h, { preferred: placement, ...sceneContext })
          // Next free cell in reading order; cameras already placed never move
          : findSequentialSpot(previousTiles, span.w, span.h);
      return normalizeSceneOrigin([...previousTiles, { ...candidateTile, x: spot.x, y: spot.y }]);
    });
    if (placement) {
      setWorkspaceAutoGrid(workspaceAutoExpandedDropRef.current);
    } else if (shouldAutoTile || (workspaceAutoGrid && options.autoFit !== false)) {
      setWorkspaceAutoGrid(true);
    }
    setCurrentPage(0);
    setSelectedStream(cameraId);
  }, [activeLayoutId, streamByName, workspaceAutoGrid, workspaceLocked]);

  const openBlankWorkspaceWithCameras = useCallback((cameraNames) => {
    const requestedCameraNames = Array.isArray(cameraNames) ? cameraNames : [];
    const availableCameraNames = requestedCameraNames
      .map((cameraName) => String(cameraName || '').trim())
      .filter(Boolean)
      .filter((cameraName, index, list) => list.indexOf(cameraName) === index)
      .filter((cameraName) => streamByName.has(cameraName));
    if (availableCameraNames.length > layoutMaxItemsRef.current) {
      availableCameraNames.length = layoutMaxItemsRef.current;
      window.setTimeout(showLayoutFullMessage, 0);
    }

    if (availableCameraNames.length === 0) {
      if (streamByName.size === 0) {
        try {
          sessionStorage.setItem(PENDING_BLANK_WORKSPACE_CAMERAS_KEY, JSON.stringify(requestedCameraNames));
        } catch {}
      } else {
        showStatusMessage('Selected cameras are not available in Live View', 'error', 5000);
      }
      return;
    }

    // Opens in its own "New Layout" tab (or the current one if it is an empty new layout)
    prepareNewLayoutTab();
    setActiveLayoutId('');
    setSingleCameraView(null);
    setHydratedLayoutId('');
    setSavedPayloadKey('');
    setWorkspaceStarted(true);
    setWorkspaceAutoGrid(true);
    captureTileRects();
    setWorkspaceTiles(buildResponsiveWorkspaceLayout(
      availableCameraNames.reduce((tiles, cameraName) => {
        // The first camera sets the cell shape; the others get cells shaped like their picture
        const span = cameraSpanRef.current(cameraName, tiles);
        return [...tiles, createWorkspaceTile(cameraName, { w: span.w, h: span.h })];
      }, [])
    ));
    setCurrentPage(0);
    setSelectedStream(availableCameraNames[0]);
    setLayoutPresetMenuOpen(false);
    setWorkspaceMenuOpen(false);
  }, [streamByName]);

  const applyWorkspacePreset = useCallback((preset) => {
    if (workspaceLocked) {
      showLockedLayoutMessage();
      return;
    }
    captureTileRects();
    setWorkspaceTiles((previousTiles) => {
      const presetSlots = buildWorkspacePresetSlots(preset);
      const existingCameraTiles = previousTiles.filter((tile) => tile.type !== 'slot' && tile.cameraId);
      const arrangedTiles = existingCameraTiles.slice(0, presetSlots.length).map((tile, index) => {
        const targetSlot = presetSlots[index];
        return normalizeWorkspaceBounds({
          ...tile,
          x: targetSlot.x,
          y: targetSlot.y,
          w: targetSlot.w,
          h: targetSlot.h,
        }, WORKSPACE_GRID_COLS, WORKSPACE_GRID_ROWS);
      });
      const remainingSlots = presetSlots.slice(arrangedTiles.length);
      const overflowTiles = existingCameraTiles.slice(presetSlots.length);

      return [...arrangedTiles, ...remainingSlots, ...overflowTiles];
    });
    setWorkspaceStarted(true);
    setWorkspaceAutoGrid(false);
    setCurrentPage(0);
  }, [workspaceLocked]);

  const removeWorkspaceTile = useCallback((instanceId) => {
    if (workspaceLocked) {
      showLockedLayoutMessage();
      return;
    }
    if (!instanceId || removeTimeoutsRef.current.has(instanceId)) return;

    setRemovingTileIds((previousIds) => {
      const nextIds = new Set(previousIds);
      nextIds.add(instanceId);
      return nextIds;
    });

    const timeoutId = window.setTimeout(() => {
      captureTileRects();
      setWorkspaceTiles((previousTiles) => {
        const nextTiles = previousTiles.filter((tile) => tile.instanceId !== instanceId);
        return workspaceAutoGrid ? buildResponsiveWorkspaceLayout(nextTiles) : nextTiles;
      });
      setRemovingTileIds((previousIds) => {
        const nextIds = new Set(previousIds);
        nextIds.delete(instanceId);
        return nextIds;
      });
      removeTimeoutsRef.current.delete(instanceId);
    }, 190);

    removeTimeoutsRef.current.set(instanceId, timeoutId);
  }, [workspaceAutoGrid, workspaceLocked]);

  const removeSelectedTiles = useCallback((instanceIds) => {
    setTileContextMenu(null);
    if (workspaceLocked) {
      showLockedLayoutMessage();
      return;
    }
    instanceIds.forEach((instanceId) => removeWorkspaceTile(instanceId));
    setSelectedTileIds([]);
  }, [removeWorkspaceTile, workspaceLocked]);

  const selectTileFromClick = useCallback((event, instanceId) => {
    if (lastPointerDraggedRef.current) return;
    if (event.target?.closest?.('button, input, select, textarea, a, .stream-controls, .live-workspace-resize-handle')) return;
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    setSelectedTileIds((previousIds) => {
      if (!additive) return [instanceId];
      return previousIds.includes(instanceId)
        ? previousIds.filter((id) => id !== instanceId)
        : [...previousIds, instanceId];
    });
  }, []);

  const openTileContextMenu = useCallback((event, instanceId) => {
    event.preventDefault();
    event.stopPropagation();
    // Right-click on a camera outside the selection selects just that camera
    let ids = selectedTileIds;
    if (!ids.includes(instanceId)) {
      ids = (event.ctrlKey || event.metaKey) ? [...ids, instanceId] : [instanceId];
      setSelectedTileIds(ids);
    }
    const menuWidth = 208;
    const menuHeight = 96;
    setTileContextMenu({
      x: Math.min(event.clientX, window.innerWidth - menuWidth - 8),
      y: Math.min(event.clientY, window.innerHeight - menuHeight - 8),
      ids,
    });
  }, [selectedTileIds]);

  // Rubber-band selection: drag a box over empty space, cameras it touches are selected
  const startSelectionBox = useCallback((event) => {
    const viewport = sceneViewportRef.current;
    if (!viewport) return;
    event.preventDefault();
    const additive = event.ctrlKey || event.metaKey || event.shiftKey;
    const startIds = additive ? selectedTileIdsRef.current : [];
    const startX = event.clientX;
    const startY = event.clientY;
    let active = false;
    if (!additive) setSelectedTileIds((previousIds) => (previousIds.length ? [] : previousIds));

    const move = (moveEvent) => {
      if (!active && Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) < 5) return;
      active = true;
      lastPointerDraggedRef.current = true;
      const view = viewport.getBoundingClientRect();
      const left = Math.max(view.left, Math.min(startX, moveEvent.clientX));
      const top = Math.max(view.top, Math.min(startY, moveEvent.clientY));
      const right = Math.min(view.right, Math.max(startX, moveEvent.clientX));
      const bottom = Math.min(view.bottom, Math.max(startY, moveEvent.clientY));
      setSelectionBox({ left: left - view.left, top: top - view.top, width: right - left, height: bottom - top });
      const touched = [];
      viewport.querySelectorAll('.live-workspace-tile[data-tile-id]').forEach((tileElement) => {
        // The picture frame, not the cell around it
        const frame = (tileElement.querySelector('.live-tile-frame') || tileElement).getBoundingClientRect();
        if (frame.left < right && frame.right > left && frame.top < bottom && frame.bottom > top) {
          touched.push(tileElement.dataset.tileId);
        }
      });
      const nextIds = [...startIds, ...touched.filter((id) => !startIds.includes(id))];
      setSelectedTileIds((previousIds) => (previousIds.join() === nextIds.join() ? previousIds : nextIds));
    };
    const up = () => {
      setSelectionBox(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }, []);

  // Forget selected cameras that are no longer in the layout
  useEffect(() => {
    setSelectedTileIds((previousIds) => {
      const nextIds = previousIds.filter((id) => workspaceTiles.some((tile) => tile.instanceId === id && tile.type !== 'slot'));
      return nextIds.length === previousIds.length ? previousIds : nextIds;
    });
  }, [workspaceTiles]);

  // Ctrl+A selects every camera in the layout, Delete removes the selection, Esc clears it
  useEffect(() => {
    if (!workspaceStarted) return undefined;
    const handleKeyDown = (event) => {
      const target = event.target;
      if (target?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], .modal')) return;
      if (document.fullscreenElement) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
        const cameraIds = workspaceTilesRef.current
          .filter((tile) => tile.type !== 'slot')
          .map((tile) => tile.instanceId);
        if (cameraIds.length === 0) return;
        event.preventDefault();
        setSelectedTileIds(cameraIds);
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && selectedTileIds.length > 0) {
        event.preventDefault();
        removeSelectedTiles(selectedTileIds);
      } else if (event.key === 'Escape') {
        setTileContextMenu(null);
        setTabContextMenu(null);
        setSelectedTileIds([]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [removeSelectedTiles, selectedTileIds, workspaceStarted]);

  // Close the camera (or tab) menu on any click elsewhere, scroll or window resize
  useEffect(() => {
    if (!tileContextMenu && !tabContextMenu) return undefined;
    const close = (event) => {
      if (event?.target?.closest?.('.live-tile-context-menu')) return;
      setTileContextMenu(null);
      setTabContextMenu(null);
    };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('wheel', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close, true);
      window.removeEventListener('wheel', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [tileContextMenu, tabContextMenu]);

  const getWorkspaceCellSize = useCallback(() => {
    const grid = workspaceGridRef.current;
    if (!grid) return { width: 1, height: 1 };

    const rect = getGridContentRect(grid, sceneZoomRef.current.scale);
    const styles = window.getComputedStyle(grid);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || '0') || 0;
    const safeCols = Math.max(1, workspaceGridCols);
    const safeRows = Math.max(1, workspaceGridRows);
    return {
      width: Math.max(1, (rect.width - (gap * (safeCols - 1))) / safeCols + gap),
      height: Math.max(1, (rect.height - (gap * (safeRows - 1))) / safeRows + gap),
    };
  }, [workspaceGridCols, workspaceGridRows]);

  const handleWorkspacePointerMove = useCallback((event) => {
    const state = workspacePointerRef.current;
    if (!state) return;

    event.preventDefault();
    if (Math.abs(event.clientX - state.startX) + Math.abs(event.clientY - state.startY) > 4) {
      lastPointerDraggedRef.current = true;
    }
    const zoom = sceneZoomRef.current.scale || 1;
    const dx = (event.clientX - state.startX) / zoom;
    const dy = (event.clientY - state.startY) / zoom;
    const start = state.startTile;
    const element = state.element;
    const tiles = workspaceTilesRef.current;
    let target;

    if (state.mode === 'move') {
      // The tile follows the pointer; over another camera it swaps (Nx Witness style)
      element.style.transform = `translate(${dx}px, ${dy}px)`;
      const pointerCell = {
        x: Math.floor((event.clientX - state.contentLeft) / (state.cellW * state.zoom)),
        y: Math.floor((event.clientY - state.contentTop) / (state.cellH * state.zoom)),
      };
      const overTile = findTileAtPoint(tiles, pointerCell, state.instanceId);
      const dropTarget = overTile && overTile.type !== 'slot' ? overTile : null;
      const dropTargetId = dropTarget?.instanceId || '';
      if (dropTargetId !== state.dropTargetId) {
        state.dropTargetId = dropTargetId;
        setTileDropTargetId(dropTargetId);
      }
      target = dropTarget
        ? { x: dropTarget.x, y: dropTarget.y, w: dropTarget.w, h: dropTarget.h, valid: true }
        : {
          // Free cells anywhere on the grid, also outside the current scene
          x: start.x + Math.round(dx / state.cellW),
          y: start.y + Math.round(dy / state.cellH),
          w: start.w,
          h: start.h,
        };
    } else {
      // Corner resize keeps the camera's shape: the frame follows the pointer
      // proportionally, then snaps to whole multiples of the camera's cell span
      const growsLeft = state.edges.includes('w');
      const growsUp = state.edges.includes('n');
      const scaleX = (state.startWidth + (growsLeft ? -dx : dx)) / state.startWidth;
      const scaleY = (state.startHeight + (growsUp ? -dy : dy)) / state.startHeight;
      // Follow the direction dragged most, so dragging straight down or sideways also resizes
      const scale = Math.max(0.3, Math.abs(scaleX - 1) >= Math.abs(scaleY - 1) ? scaleX : scaleY);
      const width = state.startWidth * scale;
      const height = state.startHeight * scale;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      element.style.justifySelf = 'start';
      element.style.alignSelf = 'start';
      element.style.transform = `translate(${growsLeft ? state.startWidth - width : 0}px, ${growsUp ? state.startHeight - height : 0}px)`;
      const base = state.baseSpan;
      const steps = Math.max(1, Math.min(
        Math.floor(SCENE_MAX_SIDE / Math.max(base.w, base.h)),
        Math.round(Math.max((width + state.tileGap) / state.cellW / base.w, (height + state.tileGap) / state.cellH / base.h))
      ));
      // Only free cells (Nx Witness): grow as far as free cells allow, never over another camera
      const rectFor = (count) => {
        const w = base.w * count;
        const h = base.h * count;
        return {
          x: growsLeft ? start.x + start.w - w : start.x,
          y: growsUp ? start.y + start.h - h : start.y,
          w,
          h,
        };
      };
      let fitted = steps;
      while (fitted > 1 && !placeTileOnFreeCells(tiles, state.instanceId, rectFor(fitted))) fitted -= 1;
      target = rectFor(fitted);
      target.valid = Boolean(placeTileOnFreeCells(tiles, state.instanceId, target));
      // Asked for more than fits: other cameras are in the way
      target.blocked = fitted < steps;
    }

    if (target.valid === undefined) {
      const rect = { x: target.x, y: target.y, w: target.w, h: target.h };
      // Moving: only free cells (green); cells used by another camera are red
      target.valid = Boolean(placeTileOnFreeCells(tiles, state.instanceId, rect));
    }
    const previous = state.target;
    if (!previous || previous.x !== target.x || previous.y !== target.y || previous.w !== target.w ||
        previous.h !== target.h || previous.valid !== target.valid || previous.blocked !== target.blocked) {
      state.target = target;
      setSnapPreview(target);
    }
  }, [getWorkspaceGridPoint]);

  const finishWorkspacePointer = useCallback(() => {
    const state = workspacePointerRef.current;
    if (state) {
      // Start the glide from where the tile is now (following the pointer)
      captureTileRects();
      const element = state.element;
      if (element) {
        element.style.transform = '';
        element.style.width = '';
        element.style.height = '';
        element.style.justifySelf = '';
        element.style.alignSelf = '';
      }
      const target = state.target;
      if (state.mode === 'move' && state.dropTargetId) {
        const { instanceId, dropTargetId } = state;
        setWorkspaceTiles((previousTiles) => normalizeSceneOrigin(swapTilePlaces(previousTiles, instanceId, dropTargetId)));
      } else if (target?.valid) {
        setWorkspaceAutoGrid(false);
        setWorkspaceTiles((previousTiles) => placeTileOnFreeCells(
          previousTiles,
          state.instanceId,
          { x: target.x, y: target.y, w: target.w, h: target.h }
        ) || [...previousTiles]);
      } else {
        // Nowhere valid to go: glide back (re-render so the animation runs)
        setWorkspaceTiles((previousTiles) => [...previousTiles]);
      }
    }
    setMovingTileId('');
    setResizingTileId('');
    setTileDropTargetId('');
    setSnapPreview(null);
    setGridOverlay(null);
    document.body.classList.remove('is-scene-resizing-nwse', 'is-scene-resizing-nesw');
    workspacePointerRef.current = null;
    window.removeEventListener('pointermove', handleWorkspacePointerMove);
    window.removeEventListener('pointerup', finishWorkspacePointer);
    window.removeEventListener('pointercancel', finishWorkspacePointer);
  }, [captureTileRects, handleWorkspacePointerMove]);

  const startWorkspacePointer = useCallback((event, tile, mode = 'move', edges = '') => {
    lastPointerDraggedRef.current = false;
    // Only the main button moves or resizes; right-click opens the camera menu
    if (event.button !== undefined && event.button !== 0) return;
    // Shift + drag over a camera draws a selection box instead of moving it
    if (mode === 'move' && event.shiftKey) return;
    if (!workspaceStarted || !tile) return;
    if (workspaceLocked) return;
    if (isMobileViewport) return;

    const target = event.target;
    if (
      mode === 'move' &&
      target?.closest?.('button, input, select, textarea, a, .stream-controls, .live-workspace-tile-close, .live-workspace-resize-handle')
    ) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    if (mode === 'resize') {
      setWorkspaceAutoGrid(false);
    }
    if (mode === 'move') {
      setMovingTileId(tile.instanceId);
    } else {
      setResizingTileId(tile.instanceId);
    }
    const element = event.currentTarget.closest?.('.live-workspace-tile') || event.currentTarget;
    const grid = workspaceGridRef.current;
    const styles = grid ? window.getComputedStyle(grid) : null;
    const contentWidth = grid ? grid.clientWidth - (Number.parseFloat(styles.paddingLeft) || 0) - (Number.parseFloat(styles.paddingRight) || 0) : 1;
    const contentHeight = grid ? grid.clientHeight - (Number.parseFloat(styles.paddingTop) || 0) - (Number.parseFloat(styles.paddingBottom) || 0) : 1;
    // Grid lines across the whole view while editing, aligned with the cells
    const zoom = sceneZoomRef.current.scale || 1;
    const contentRect = grid ? getGridContentRect(grid, zoom) : { left: 0, top: 0 };
    const viewportRect = sceneViewportRef.current?.getBoundingClientRect() || { left: 0, top: 0 };
    const cellWidthPx = Math.max(1, contentWidth / Math.max(1, gridDimsRef.current.cols));
    const cellHeightPx = Math.max(1, contentHeight / Math.max(1, gridDimsRef.current.rows));
    setGridOverlay({
      left: contentRect.left - viewportRect.left,
      top: contentRect.top - viewportRect.top,
      cellW: cellWidthPx * zoom,
      cellH: cellHeightPx * zoom,
    });
    if (mode === 'resize') {
      document.body.classList.add(edges === 'ne' || edges === 'sw' ? 'is-scene-resizing-nesw' : 'is-scene-resizing-nwse');
    }
    // Smallest span with the camera's shape (e.g. 1x1 for 16:9 in 16:9 cells, 1x3 for portrait)
    const tileAspect = tile.cameraId ? getCameraAspectRef.current(tile.cameraId) : null;
    const baseSpan = tileAspect ? spanForAspect(tileAspect, sceneContext.cellAspect) : { w: 1, h: 1 };
    workspacePointerRef.current = {
      mode,
      edges,
      dropTargetId: '',
      element,
      baseSpan,
      // Top-left of cell (0, 0) on screen, to find the cell under the pointer anywhere
      contentLeft: contentRect.left,
      contentTop: contentRect.top,
      zoom,
      // Cell size and tile size in layout pixels (before zoom)
      cellW: Math.max(1, contentWidth / Math.max(1, gridDimsRef.current.cols)),
      cellH: Math.max(1, contentHeight / Math.max(1, gridDimsRef.current.rows)),
      tileGap: Number.parseFloat(styles?.getPropertyValue('--tile-gap-px')) || 0,
      startWidth: element.offsetWidth,
      startHeight: element.offsetHeight,
      target: null,
      instanceId: tile.instanceId,
      startTile: { ...tile },
      startX: event.clientX,
      startY: event.clientY,
    };
    window.addEventListener('pointermove', handleWorkspacePointerMove);
    window.addEventListener('pointerup', finishWorkspacePointer);
    window.addEventListener('pointercancel', finishWorkspacePointer);
  }, [finishWorkspacePointer, handleWorkspacePointerMove, isMobileViewport, workspaceLocked, workspaceStarted]);

  useEffect(() => () => {
    finishWorkspacePointer();
    removeTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    removeTimeoutsRef.current.clear();
    if (saveLayoutTimeoutRef.current) {
      window.clearTimeout(saveLayoutTimeoutRef.current);
      saveLayoutTimeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('oneberry:live-layout-edit-mode', {
      detail: {
        layoutId: activeLayoutId,
        // The sidebar can add cameras to (or remove them from) the open layout
        editing: Boolean(activeLayoutId && !workspaceLocked),
      },
    }));
  }, [activeLayoutId, workspaceLocked]);

  useEffect(() => () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('oneberry:live-layout-edit-mode', {
      detail: { layoutId: activeLayoutId, editing: false },
    }));
  }, [activeLayoutId]);


  useEffect(() => {
    const handleAddCamera = (event) => {
      const cameraNames = Array.isArray(event.detail?.cameraNames)
        ? event.detail.cameraNames
        : [event.detail?.cameraName];
      cameraNames
        .map((cameraName) => String(cameraName || '').trim())
        .filter(Boolean)
        .forEach((cameraName) => addWorkspaceTile(cameraName, null, {
          autoFit: event.detail?.autoFit !== false,
        }));
    };

    window.addEventListener('oneberry:add-live-camera', handleAddCamera);
    return () => window.removeEventListener('oneberry:add-live-camera', handleAddCamera);
  }, [addWorkspaceTile]);

  useEffect(() => {
    const handleOpenBlankLayout = (event) => {
      const cameraNames = Array.isArray(event.detail?.cameraNames)
        ? event.detail.cameraNames
        : [event.detail?.cameraName];
      openBlankWorkspaceWithCameras(cameraNames);
    };

    window.addEventListener('oneberry:open-blank-live-layout', handleOpenBlankLayout);
    return () => window.removeEventListener('oneberry:open-blank-live-layout', handleOpenBlankLayout);
  }, [openBlankWorkspaceWithCameras]);

  useEffect(() => {
    if (streamByName.size === 0) return;

    let pendingCameraNames = [];
    try {
      const raw = sessionStorage.getItem(PENDING_BLANK_WORKSPACE_CAMERAS_KEY);
      pendingCameraNames = raw ? JSON.parse(raw) : [];
      sessionStorage.removeItem(PENDING_BLANK_WORKSPACE_CAMERAS_KEY);
    } catch {
      pendingCameraNames = [];
    }

    if (Array.isArray(pendingCameraNames) && pendingCameraNames.length > 0) {
      openBlankWorkspaceWithCameras(pendingCameraNames);
    }
  }, [openBlankWorkspaceWithCameras, streamByName.size]);

  useEffect(() => {
    const handleShowLayout = (event) => {
      const layoutId = String(event.detail?.layoutId || '').trim();
      setLayoutPresetMenuOpen(false);
      setWorkspaceMenuOpen(false);
      // Back from the single camera view of the layout that is already open
      if (tabStateRef.current.singleCameraView && layoutId === tabStateRef.current.activeLayoutId) {
        exitSingleCameraView(layoutId);
        return;
      }
      if (layoutId) {
        openLayoutInTab(layoutId);
      } else {
        exitSingleCameraView(layoutId);
      }
      setWorkspaceMenuOpen(false);
    };

    const handleShowLayoutCamera = (event) => {
      const layoutId = String(event.detail?.layoutId || '').trim();
      const cameraId = String(event.detail?.cameraId || event.detail?.cameraName || '').trim();
      enterSingleCameraView(layoutId, cameraId);
    };

    const handleNavigate = () => {
      const layoutParam = new URLSearchParams(window.location.search).get('layout') || '';
      if (layoutParam === 'workspace') {
        const state = tabStateRef.current;
        const emptyTab = state.layoutTabs.find((tab) => !tab.layoutId && !tab.draft && tab.key !== state.activeTabKey);
        if (!state.activeLayoutId && !state.isDraft) return;
        if (emptyTab) switchToLayoutTab(emptyTab.key);
        else openNewLayoutTab();
      } else if (layoutParam && layoutParam !== tabStateRef.current.activeLayoutId) {
        openLayoutInTab(layoutParam);
      }
    };
    window.addEventListener('oneberry:navigate', handleNavigate);
    window.addEventListener('popstate', handleNavigate);
    window.addEventListener('oneberry:show-live-layout', handleShowLayout);
    window.addEventListener('oneberry:show-live-layout-camera', handleShowLayoutCamera);
    return () => {
      window.removeEventListener('oneberry:show-live-layout', handleShowLayout);
      window.removeEventListener('oneberry:show-live-layout-camera', handleShowLayoutCamera);
      window.removeEventListener('oneberry:navigate', handleNavigate);
      window.removeEventListener('popstate', handleNavigate);
    };
  }, [enterSingleCameraView, exitSingleCameraView]);

  useEffect(() => {
    const handleRemoveLayoutCamera = (event) => {
      const detail = event.detail || {};
      if (detail.layoutId !== activeLayoutId || workspaceLocked) return;

      const tileId = String(detail.tileId || '');
      const cameraName = String(detail.cameraName || '');
      const tile = workspaceTiles.find((candidate) => (
        candidate.type !== 'slot' &&
        (
          (tileId && candidate.instanceId === tileId) ||
          (!tileId && cameraName && candidate.cameraId === cameraName)
        )
      ));
      if (tile) {
        removeWorkspaceTile(tile.instanceId);
      }
    };

    window.addEventListener('oneberry:remove-live-layout-camera', handleRemoveLayoutCamera);
    return () => window.removeEventListener('oneberry:remove-live-layout-camera', handleRemoveLayoutCamera);
  }, [activeLayoutId, removeWorkspaceTile, workspaceLocked, workspaceTiles]);

  const saveCurrentWorkspaceAsLayout = useCallback(async (layoutName) => {
    const name = String(layoutName || '').trim();
    if (!name) return null;

    const tiles = serializeWorkspaceTilesForSave(workspaceTiles);
    const slots = serializeWorkspaceSlotsForSave(workspaceTiles);
    const nextLayout = {
      id: createLiveLayoutId(),
      name,
      units: 'cells',
      cellAspect: layoutCellAspect,
      cellSpacing: layoutCellSpacing,
      tiles,
      slots,
      cameras: tiles.map((tile) => tile.camera),
    };
    const previousLayouts = liveLayouts;
    const saved = await saveLiveLayouts({
      layouts: [...liveLayouts.layouts, nextLayout],
    }, previousLayouts);
    const savedLayout = saved.layouts.find((layout) => layout.id === nextLayout.id) || nextLayout;
    // The tab now shows the saved layout, with no unsaved changes
    setActiveLayoutId(savedLayout.id);
    setHydratedLayoutId(savedLayout.id);
    setSavedPayloadKey(layoutPayloadKey(savedLayout.id, layoutCellAspect, layoutCellSpacing, workspaceTiles));
    showStatusMessage(`Layout "${savedLayout.name}" saved`);
    return savedLayout;
  }, [layoutCellAspect, layoutCellSpacing, liveLayouts, saveLiveLayouts, workspaceTiles]);

  const saveCurrentWorkspaceLayout = useCallback(async () => {
    if (!activeLayoutId || !activeLayout) {
      const name = window.prompt('Layout name', activeTabTitleRef.current || '');
      if (!name) return false;
      return Boolean(await saveCurrentWorkspaceAsLayout(name));
    }
    if (activeLayout.sharedWithMe || activeLayout.locked) {
      showLockedLayoutMessage();
      return false;
    }

    const tiles = serializeWorkspaceTilesForSave(workspaceTiles);
    const slots = serializeWorkspaceSlotsForSave(workspaceTiles);
    const previousLayouts = liveLayouts;
    const nextLayouts = {
      layouts: liveLayouts.layouts.map((layout) => (
        layout.id === activeLayoutId
          ? {
            ...layout,
            units: 'cells',
            cellAspect: layoutCellAspect,
            cellSpacing: layoutCellSpacing,
            tiles,
            slots,
            cameras: tiles.map((tile) => tile.camera),
          }
          : layout
      )),
    };
    await saveLiveLayouts(nextLayouts, previousLayouts);
    setSavedPayloadKey(layoutPayloadKey(activeLayoutId, layoutCellAspect, layoutCellSpacing, workspaceTiles));
    showStatusMessage('Layout saved');
    return true;
  }, [activeLayout, activeLayoutId, layoutCellAspect, layoutCellSpacing, liveLayouts, saveCurrentWorkspaceAsLayout, saveLiveLayouts, workspaceTiles]);

  saveActiveTabRef.current = () => {
    if (workspaceLocked) {
      if (activeLayoutId) showLockedLayoutMessage();
      return;
    }
    saveCurrentWorkspaceLayout();
  };

  const renameCurrentWorkspaceLayout = useCallback(async () => {
    if (!activeLayoutId || !activeLayout) return;
    const name = window.prompt('Layout name', activeLayout.name);
    const trimmed = String(name || '').trim();
    if (!trimmed || trimmed === activeLayout.name) return;

    await saveLiveLayouts({
      layouts: liveLayouts.layouts.map((layout) => (
        layout.id === activeLayoutId ? { ...layout, name: trimmed } : layout
      )),
    }, liveLayouts);
  }, [activeLayout, activeLayoutId, liveLayouts, saveLiveLayouts]);

  const deleteCurrentWorkspaceLayout = useCallback(async () => {
    if (!activeLayoutId || !activeLayout) return;
    if (!window.confirm(`Delete layout "${activeLayout.name}"?`)) return;

    await saveLiveLayouts({
      layouts: liveLayouts.layouts.filter((layout) => layout.id !== activeLayoutId),
    }, liveLayouts);
    // Its tab closes
    closeLayoutTab(tabStateRef.current.activeTabKey, { force: true });
  }, [activeLayout, activeLayoutId, liveLayouts, saveLiveLayouts]);

  // Change settings of the open saved layout (lock, sharing, background) and save
  const updateActiveLayout = useCallback(async (changes, message) => {
    if (!activeLayoutId || !activeLayout || activeLayout.sharedWithMe) return false;
    try {
      await saveLiveLayouts({
        layouts: liveLayouts.layouts.map((layout) => (
          layout.id === activeLayoutId ? { ...layout, ...changes } : layout
        )),
      }, liveLayouts);
      if (message) showStatusMessage(message);
      return true;
    } catch {
      return false;
    }
  }, [activeLayout, activeLayoutId, liveLayouts, saveLiveLayouts]);

  const toggleActiveLayoutLock = useCallback(async () => {
    if (!activeLayout) return;
    const locked = !activeLayout.locked;
    if (locked) {
      // Save pending edits first, then lock what is on screen
      if (tabStateRef.current.isDraft) await saveCurrentWorkspaceLayout();
    }
    await updateActiveLayout({ locked }, locked ? 'Layout locked. Unlock it to make changes.' : 'Layout unlocked');
  }, [activeLayout, saveCurrentWorkspaceLayout, updateActiveLayout]);

  const openShareDialog = useCallback(async () => {
    try {
      const data = await fetchJSON('/api/auth/users', { headers: getAuthHeaders(), timeout: 10000, retries: 1 });
      const ownerId = Number(activeLayout?.userId);
      setShareUsers((data?.users || []).filter((user) => user.is_active !== false && Number(user.id) !== ownerId));
      setShareSelection(Array.isArray(activeLayout?.sharedWith) ? activeLayout.sharedWith : []);
      setShareDialogOpen(true);
    } catch (error) {
      showStatusMessage(error.message || 'Could not load users', 'error', 6000);
    }
  }, [activeLayout]);

  const saveShareSelection = useCallback(async () => {
    const ok = await updateActiveLayout(
      { sharedWith: shareSelection },
      shareSelection.length > 0 ? `Layout shared with ${shareSelection.length} user${shareSelection.length === 1 ? '' : 's'}` : 'Layout is no longer shared'
    );
    if (ok) setShareDialogOpen(false);
  }, [shareSelection, updateActiveLayout]);

  // Background picture (map or floor plan): shrunk in the browser to fit the 1 MB upload limit
  const uploadLayoutBackground = useCallback(async (file) => {
    if (!file || !activeLayoutId) return;
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      let blob = null;
      for (const quality of [0.85, 0.7, 0.55, 0.4]) {
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (blob && blob.size <= 1000 * 1000) break;
      }
      if (!blob || blob.size > 1000 * 1000) throw new Error('The picture is too large even after shrinking it');
      const response = await fetch(`/api/live-layouts/${encodeURIComponent(activeLayoutId)}/background`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/jpeg', ...getAuthHeaders() },
        body: blob,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `Upload failed (${response.status})`);
      queryClient.setQueryData(['live-layouts'], (previous) => normalizeLiveLayouts({
        layouts: (previous?.layouts || []).map((layout) => (
          layout.id === activeLayoutId ? { ...layout, background: data.background } : layout
        )),
      }));
      showStatusMessage('Background set');
    } catch (error) {
      showStatusMessage(error.message || 'Could not set the background', 'error', 6000);
    }
  }, [activeLayoutId, queryClient]);

  const removeLayoutBackground = useCallback(async () => {
    if (!activeLayoutId) return;
    const response = await fetch(`/api/live-layouts/${encodeURIComponent(activeLayoutId)}/background`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      showStatusMessage(data?.error || 'Could not remove the background', 'error', 6000);
      return;
    }
    queryClient.setQueryData(['live-layouts'], (previous) => normalizeLiveLayouts({
      layouts: (previous?.layouts || []).map((layout) => {
        if (layout.id !== activeLayoutId) return layout;
        const { background, ...rest } = layout;
        return rest;
      }),
    }));
    showStatusMessage('Background removed');
  }, [activeLayoutId, queryClient]);

  const resetCurrentWorkspaceLayout = useCallback(() => {
    setWorkspaceTiles([]);
    setWorkspaceStarted(true);
    setCurrentPage(0);
    setWorkspaceAutoGrid(true);
  }, [activeLayoutId]);

  useEffect(() => {
    if (workspaceStarted || !workspaceAutoGrid || workspaceTiles.length === 0) return;

    const targetCells = Math.min(
      MAX_GRID_CELLS,
      workspaceTiles.length <= 2 ? workspaceTiles.length : workspaceTiles.length + 1
    );
    const [optCols, optRows] = computeOptimalGrid(targetCells);
    setCols(optCols);
    setRows(optRows);
    setWorkspaceTiles((previousTiles) => reflowWorkspaceTiles(previousTiles, optCols));
  }, [workspaceAutoGrid, workspaceTiles.length]);

  useEffect(() => {
    if (workspaceStarted || workspaceTiles.length <= 2 || rows > 1 || cols <= 3) return;

    const targetCells = Math.min(MAX_GRID_CELLS, Math.max(4, workspaceTiles.length + 1));
    const [optCols, optRows] = computeOptimalGrid(targetCells);
    setCols(optCols);
    setRows(optRows);
    setWorkspaceTiles((previousTiles) => reflowWorkspaceTiles(previousTiles, optCols));
    setWorkspaceAutoGrid(true);
  }, [cols, rows, workspaceStarted, workspaceTiles.length]);

  const buildingTree = useMemo(() => buildBuildingTree(
    streams,
    {
      unassignedBuilding: t('sidebar.unassignedBuilding'),
      generalArea: t('sidebar.generalArea'),
    },
    locationCatalog
  ).filter((building) => building.tag), [locationCatalog, streams, t]);
  const selectedBuilding = useMemo(() => {
    if (!tagFilter) return null;
    return buildingTree.find((building) => (
      building.tag === tagFilter || building.areas.some((area) => area.tag === tagFilter)
    )) || null;
  }, [buildingTree, tagFilter]);
  const selectedAreaTag = selectedBuilding?.areas.some((area) => area.tag === tagFilter) ? tagFilter : '';
  const selectedBuildingTag = selectedBuilding?.tag || '';

  // Apply tag filter before passing to the order hook
  const tagFilteredStreams = useMemo(() => {
    if (!tagFilter) return streams;
    return streams.filter(s => s.tags && s.tags.split(',').some(t => t.trim() === tagFilter));
  }, [streams, tagFilter]);

  // Camera ordering hook (operates on group-filtered streams)
  const {
    orderedStreams,
    reorderMode,
    toggleReorderMode,
    resetOrder,
    handleDragStart,
    handleDragOver,
    handleDrop,
    handleDragEnd,
  } = useCameraOrder(tagFilteredStreams, storagePrefix);

  // Ensure current page is valid when orderedStreams or layout changes
  useEffect(() => {
    if (workspaceTiles.length > 0) {
      const totalPages = Math.ceil(workspaceTiles.length / maxStreams);

      if (currentPage >= totalPages) {
        setCurrentPage(Math.max(0, totalPages - 1));
      }
      return;
    }

    if (orderedStreams.length === 0) return;

    const totalPages = Math.ceil(orderedStreams.length / maxStreams);

    if (currentPage >= totalPages) {
      setCurrentPage(Math.max(0, totalPages - 1));
    }
  }, [workspaceTiles.length, orderedStreams.length, maxStreams, currentPage]);

  /**
   * Toggle fullscreen mode for a specific stream
   * @param {string} streamName - Stream name
   * @param {Event} event - Click event
   * @param {HTMLElement} cellElement - The video cell element
   */
  const toggleStreamFullscreen = (streamName, event, cellElement) => {
    // Prevent default button behavior
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    if (!streamName) {
      console.error('Stream name not provided for fullscreen toggle');
      return;
    }

    console.log(`Toggling fullscreen for stream: ${streamName}`);

    if (!cellElement) {
      console.error('Video cell element not provided for fullscreen toggle');
      return;
    }

    if (!document.fullscreenElement) {
      console.log('Entering fullscreen mode for video cell');
      cellElement.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
        showStatusMessage(isWebRTC ? `Could not enable fullscreen mode: ${err.message}` : t('live.couldNotEnableFullscreen', { message: err.message }));
      });
    } else {
      console.log('Exiting fullscreen mode');
      document.exitFullscreen();
    }

    // Prevent event propagation
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  const workspaceStreamsToShow = useMemo(() => {
    if (workspaceStarted) {
      if (workspaceTiles.length === 0) {
        return [];
      }

      return workspaceTiles
        .map((tile) => {
          const stream = streamByName.get(tile.cameraId);
          return stream ? { stream, tile, tileInstanceId: tile.instanceId } : null;
        })
        .filter(Boolean);
    }

    return [];
  }, [workspaceStarted, workspaceTiles, streamByName]);

  // Memoize the streams to show to prevent unnecessary re-renders
  const streamsToShow = useMemo(() => {
    if (workspaceStarted) {
      const result = workspaceStreamsToShow.map((item) => item.stream);

      console.log(`[${logLabel}View] workspace streamsToShow computed: ${result.length} tiles`, workspaceStreamsToShow.map(item => `${item.stream.name}:${item.tileInstanceId}`));
      console.log(`[${logLabel}View] cols=${cols}, rows=${rows}, currentPage=${currentPage}, totalTiles=${workspaceTiles.length}`);
      return result;
    }

    // Filter streams based on layout and selected stream
    let result;
    if (isSingleStream && selectedStream) {
      result = orderedStreams.filter(stream => stream.name === selectedStream);
    } else {
      // Apply pagination
      const totalPages = Math.ceil(orderedStreams.length / maxStreams);

      // Ensure current page is valid
      if (currentPage >= totalPages && totalPages > 0) {
        result = []; // Will be handled by the effect that watches currentPage
      } else {
        // Get streams for current page
        const startIdx = currentPage * maxStreams;
        const endIdx = Math.min(startIdx + maxStreams, orderedStreams.length);
        result = orderedStreams.slice(startIdx, endIdx);
      }
    }

    console.log(`[${logLabel}View] streamsToShow computed: ${result.length} streams`, result.map(s => s.name));
    console.log(`[${logLabel}View] cols=${cols}, rows=${rows}, currentPage=${currentPage}, totalStreams=${orderedStreams.length}`);
    return result;
  }, [workspaceStarted, workspaceStreamsToShow, workspaceTiles.length, orderedStreams, isSingleStream, selectedStream, currentPage, maxStreams, cols, rows, logLabel]);

  // Arrow-key navigation between streams while one is in native fullscreen.
  useFullscreenGridNav(streamsToShow, cols, rows);

  const isWorkspaceMode = workspaceStarted;
  const orderedTotalPages = Math.ceil(orderedStreams.length / maxStreams);
  const visibleWorkspaceTileCount = singleCameraMode ? 1 : (isWorkspaceMode ? streamsToShow.length : 0);
  workspaceTilesRef.current = workspaceTiles;

  // Cell shape: chosen for the layout, or (auto) the shape of the first camera's picture
  const firstCameraName = singleCameraMode
    ? singleCameraView?.selectedCameraId
    : isWorkspaceMode
      ? [...workspaceTiles]
        .filter((tile) => tile.type !== 'slot' && tile.cameraId)
        .sort((a, b) => (a.y - b.y) || (a.x - b.x))[0]?.cameraId
      : streamsToShow[0]?.name;
  const firstCameraStream = firstCameraName ? streamByName.get(firstCameraName) : null;
  const effectiveCellAspect =
    parseAspectRatio(layoutCellAspect) ||
    parseAspectRatio(cameraDisplay[firstCameraName]?.aspectRatio) ||
    videoAspectByCamera[firstCameraName] ||
    (firstCameraStream?.width > 0 && firstCameraStream?.height > 0 ? firstCameraStream.width / firstCameraStream.height : null) ||
    16 / 9;
  const cellArrangement = singleCameraMode
    ? { cols: 1, rows: 1 }
    : isWorkspaceMode
      ? { cols: workspaceGridCols, rows: workspaceGridRows }
      : { cols, rows };

  // Shape of each camera's picture: forced in its settings, else what it sends
  const getCameraAspect = (cameraName) => {
    const stream = streamByName.get(cameraName);
    return parseAspectRatio(cameraDisplay[cameraName]?.aspectRatio) ||
      videoAspectByCamera[cameraName] ||
      (stream?.width > 0 && stream?.height > 0 ? stream.width / stream.height : null);
  };
  getCameraAspectRef.current = getCameraAspect;
  // Cells a new camera takes; the first camera on an "auto" layout sets the cell shape
  cameraSpanRef.current = (cameraName, existingTiles) => {
    const cameraTiles = (existingTiles || [])
      .filter((tile) => tile.type !== 'slot' && tile.cameraId)
      .sort((a, b) => (a.y - b.y) || (a.x - b.x));
    if (cameraTiles.length === 0 && layoutCellAspect === 'auto') return { w: 1, h: 1 };
    // Auto cells take the shape of the layout's first camera
    const cellAspect = parseAspectRatio(layoutCellAspect) ||
      getCameraAspect(cameraTiles[0]?.cameraId) ||
      effectiveCellAspect;
    sceneContext.cellAspect = cellAspect;
    return spanForAspect(getCameraAspect(cameraName), cellAspect);
  };
  sceneContext.cellAspect = effectiveCellAspect;
  if (typeof window !== 'undefined' && window.innerHeight > 0) {
    sceneContext.viewportAspect = window.innerWidth / window.innerHeight;
  }

  // Black space around the grid so every cell keeps the cell shape (before
  // paint, so tiles glide straight to their final place)
  useLayoutEffect(() => {
    const grid = workspaceGridRef.current;
    if (!grid) return undefined;
    const applied = { x: 0, y: 0 };
    const apply = (next) => {
      if (Math.abs(next.x - applied.x) < 0.5 && Math.abs(next.y - applied.y) < 0.5) return;
      applied.x = next.x;
      applied.y = next.y;
      grid.style.setProperty('--cell-pad-x', `${next.x.toFixed(1)}px`);
      grid.style.setProperty('--cell-pad-y', `${next.y.toFixed(1)}px`);
    };
    grid.style.setProperty('--cell-pad-x', '0px');
    grid.style.setProperty('--cell-pad-y', '0px');
    if (isMobileViewport) return undefined;

    const compute = () => {
      const styles = window.getComputedStyle(grid);
      const basePadX = (Number.parseFloat(styles.paddingLeft) || 0) - applied.x;
      const basePadY = (Number.parseFloat(styles.paddingTop) || 0) - applied.y;
      apply(computeCellPadding({
        width: grid.clientWidth - (2 * basePadX),
        height: grid.clientHeight - (2 * basePadY),
        cols: cellArrangement.cols,
        rows: cellArrangement.rows,
        // Workspace tiles are spaced by margins (--tile-gap); the classic grid by CSS gap
        gap: (Number.parseFloat(styles.getPropertyValue('--tile-gap-px')) || 0) + (Number.parseFloat(styles.columnGap) || 0),
        aspect: effectiveCellAspect,
      }));
    };
    compute();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(compute);
    observer.observe(grid);
    return () => observer.disconnect();
  }, [cellArrangement.cols, cellArrangement.rows, effectiveCellAspect, isMobileViewport, isWorkspaceMode, layoutCellSpacing, singleCameraMode, streamsToShow.length]);

  // Mouse wheel zooms the scene around the pointer (Nx Witness style)
  useEffect(() => {
    const viewport = sceneViewportRef.current;
    if (!viewport || !isWorkspaceMode || isMobileViewport) return undefined;
    const handleWheel = (event) => {
      if (event.deltaY === 0) return;
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) {
        // Ctrl + wheel: more or less space between cameras (Nx Witness cell spacing)
        if (workspaceLockedRef.current) return;
        const now = Date.now();
        if (now - (wheelSpacingAtRef.current || 0) < 180) return;
        wheelSpacingAtRef.current = now;
        captureTileRects();
        setLayoutCellSpacing((previous) => stepCellSpacing(previous, event.deltaY < 0 ? 1 : -1));
        return;
      }
      const rect = viewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      setSceneZoom((previous) => {
        const factor = event.deltaY < 0 ? 1.15 : 1 / 1.15;
        let scale = Math.max(SCENE_MIN_ZOOM, Math.min(SCENE_MAX_ZOOM, previous.scale * factor));
        if (Math.abs(scale - 1) < 0.04) scale = 1;
        if (scale === 1) return { scale: 1, x: 0, y: 0 };
        // Keep the point under the pointer where it is
        const ratio = scale / previous.scale;
        return clampSceneZoom({
          scale,
          x: pointerX - (pointerX - previous.x) * ratio,
          y: pointerY - (pointerY - previous.y) * ratio,
        }, viewport);
      });
    };
    viewport.addEventListener('wheel', handleWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', handleWheel);
  }, [captureTileRects, isMobileViewport, isWorkspaceMode]);

  // Zoom resets when another layout is opened
  useEffect(() => {
    setSceneZoom({ scale: 1, x: 0, y: 0 });
  }, [activeLayoutId, singleCameraMode]);

  // Glide tiles from where they were to their new cells (FLIP)
  useLayoutEffect(() => {
    const from = flipFromRef.current;
    const grid = workspaceGridRef.current;
    flipFromRef.current = null;
    if (!from || !grid || typeof Element === 'undefined' || !Element.prototype.animate) return;
    const zoom = sceneZoomRef.current.scale || 1;
    const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
    // New cameras fade in one after another, in the order they were added
    let entering = 0;
    grid.querySelectorAll('[data-tile-id]').forEach((element) => {
      const first = from[element.dataset.tileId];
      const last = element.getBoundingClientRect();
      if (!last.width || !last.height) return;
      if (!first) {
        element.animate([{ opacity: 0, transform: 'scale(0.92)' }, { opacity: 1, transform: 'none' }], {
          duration: 280,
          delay: Math.min(entering, 12) * 70,
          easing,
          fill: 'backwards',
        });
        entering += 1;
        return;
      }
      const dx = (first.left - last.left) / zoom;
      const dy = (first.top - last.top) / zoom;
      const sx = first.width / last.width;
      const sy = first.height / last.height;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
      element.animate([
        { transformOrigin: '0 0', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: '0 0', transform: 'none' },
      ], { duration: 260, easing });
    });
  }, [workspaceTiles, workspaceGridCols, workspaceGridRows, effectiveCellAspect, layoutCellSpacing]);

  // The unsaved workspace remembers its cell shape and spacing in this browser
  useEffect(() => {
    if (activeLayoutId) return;
    try {
      localStorage.setItem(LIVE_CELL_ASPECT_STORAGE_KEY, layoutCellAspect);
      localStorage.setItem(LIVE_CELL_SPACING_STORAGE_KEY, layoutCellSpacing);
    } catch {}
  }, [activeLayoutId, layoutCellAspect, layoutCellSpacing]);
  const workspaceEmptySlotCount = isWorkspaceMode
    ? (singleCameraMode ? 0 : workspaceTiles.filter((tile) => tile.type === 'slot').length)
    : 0;
  const workspacePresetLabel = getWorkspacePresetLabel(workspaceTiles);
  const singleCameraStream = singleCameraMode ? streamByName.get(singleCameraView.selectedCameraId) : null;

  const gridHasEmptySlots = !isWorkspaceMode
    && !isLoadingStreams
    && !isLoading
    && !streamsError
    && streams.length > 0
    && streamsToShow.length > 0
    && streamsToShow.length < maxStreams;

  return (
    <section
      id="live-page"
      className={`page ${isFullscreen ? 'fullscreen-mode' : ''}`}
    >
      {/* Include the SnapshotManager component */}
      <SnapshotManager />
      {/* Include the FullscreenManager component */}
      <FullscreenManager
        isFullscreen={isFullscreen}
        setIsFullscreen={setIsFullscreen}
        targetId="live-page"
      />

      <div className="page-header live-toolbar flex justify-between items-center mb-4 p-4 bg-card text-card-foreground rounded-lg shadow" style={{ position: 'relative', zIndex: 10, pointerEvents: 'auto' }}>
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold whitespace-nowrap">{t('live.liveView')}</h2>
          {/* View-mode tab strip: WebRTC | HLS | MSE */}
          <div className="inline-flex items-center bg-muted rounded-lg p-1 gap-1" style={{ position: 'relative', zIndex: 50 }}>
            {isWebRTC ? (
              <span className="px-3 py-1.5 rounded text-sm font-medium bg-primary text-primary-foreground select-none">
                WebRTC
              </span>
            ) : !isWebRTCDisabled && (
              <a
                href="/index.html"
                className="px-3 py-1.5 rounded text-sm font-medium transition-colors no-underline text-muted-foreground hover:bg-background hover:text-foreground focus:outline-none"
              >
                WebRTC
              </a>
            )}
            {isWebRTC ? (
              <a
                href="/hls.html"
                className="px-3 py-1.5 rounded text-sm font-medium transition-colors no-underline text-muted-foreground hover:bg-background hover:text-foreground focus:outline-none"
              >
                {t('live.hlsShort')}
              </a>
            ) : (
              <button
                className={`px-3 py-1.5 rounded text-sm font-medium transition-colors focus:outline-none ${!useMSE ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background hover:text-foreground'}`}
                onClick={() => {
                  if (useMSE) {
                    setUseMSE(false);
                    const url = new URL(window.location);
                    url.searchParams.delete('mode');
                    window.history.replaceState({}, '', url);
                  }
                }}
              >
                {t('live.hlsShort')}
              </button>
            )}
            {go2rtcAvailable && (
              isWebRTC ? (
                <a
                  href="/hls.html?mode=mse"
                  className="px-3 py-1.5 rounded text-sm font-medium transition-colors no-underline text-muted-foreground hover:bg-background hover:text-foreground focus:outline-none"
                >
                  {t('live.mseShort')}
                </a>
              ) : (
                <button
                  className={`px-3 py-1.5 rounded text-sm font-medium transition-colors focus:outline-none ${useMSE ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-background hover:text-foreground'}`}
                  onClick={() => {
                    if (!useMSE) {
                      setUseMSE(true);
                      const url = new URL(window.location);
                      url.searchParams.set('mode', 'mse');
                      window.history.replaceState({}, '', url);
                    }
                  }}
                >
                  {t('live.mseShort')}
                </button>
              )
            )}
          </div>
        </div>
        <div className="controls flex items-center space-x-2">
          {buildingTree.length > 0 && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="building-filter" className="text-sm whitespace-nowrap">{t('sidebar.buildings')}:</label>
              <select
                id="building-filter"
                className="px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                value={selectedBuildingTag}
                onChange={(e) => { setTagFilter(e.target.value); setCurrentPage(0); }}
              >
                <option value="">{t('live.allBuildings')}</option>
                {buildingTree.map((building) => (
                  <option key={building.key} value={building.tag}>{building.name} ({building.cameraCount})</option>
                ))}
              </select>
            </div>
          )}

          {selectedBuilding?.areas?.some((area) => area.tag) && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="area-filter" className="text-sm whitespace-nowrap">{t('streamsConfig.area')}:</label>
              <select
                id="area-filter"
                className="px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                value={selectedAreaTag}
                onChange={(e) => { setTagFilter(e.target.value || selectedBuildingTag); setCurrentPage(0); }}
              >
                <option value="">{t('live.allAreas')}</option>
                {selectedBuilding.areas.filter((area) => area.tag).map((area) => (
                  <option key={area.key} value={area.tag}>{area.name} ({area.cameras.length})</option>
                ))}
              </select>
            </div>
          )}

          {!isWorkspaceMode && (
            <div className="flex items-center gap-1.5">
              <label className="text-sm whitespace-nowrap">{t('live.layout')}:</label>
              <GridPicker
                cols={cols}
                rows={rows}
                onSelect={(c, r) => {
                  setCols(c);
                  setRows(r);
                  setWorkspaceTiles((previousTiles) => reflowWorkspaceTiles(previousTiles, c));
                  setCurrentPage(0);
                  setAutoGrid(false);
                  setWorkspaceAutoGrid(false);
                }}
                maxCells={orderedStreams.length}
              />
            </div>
          )}

          {!isWorkspaceMode && isSingleStream && (
            <div className="flex items-center gap-1.5">
              <label htmlFor="stream-selector" className="text-sm whitespace-nowrap">{isWebRTC ? t('live.stream') : t('nav.streams')}:</label>
              <select
                id="stream-selector"
                className="px-3 py-2 border border-border rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                value={selectedStream}
                onChange={(e) => setSelectedStream(e.target.value)}
              >
                {orderedStreams.map(stream => (
                  <option key={stream.name} value={stream.name}>{stream.name}</option>
                ))}
              </select>
            </div>
          )}

          <button
            className={`p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-primary ${showLabels ? 'bg-secondary hover:bg-secondary/80 text-secondary-foreground' : 'bg-primary/20 hover:bg-primary/30 text-primary'}`}
            onClick={() => setShowLabels(v => !v)}
            title={showLabels ? t('live.hideStreamLabels') : t('live.showStreamLabels')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"></path>
              <line x1="7" y1="7" x2="7.01" y2="7"></line>
              {!showLabels && <line x1="2" y1="22" x2="22" y2="2" stroke="currentColor" strokeWidth="2"></line>}
            </svg>
          </button>

          <button
            className={`p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-primary ${showControls ? 'bg-secondary hover:bg-secondary/80 text-secondary-foreground' : 'bg-primary/20 hover:bg-primary/30 text-primary'}`}
            onClick={() => setShowControls(v => !v)}
            title={showControls ? t('live.hideStreamControls') : t('live.showStreamControls')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="21" x2="4" y2="14"></line>
              <line x1="4" y1="10" x2="4" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="12"></line>
              <line x1="12" y1="8" x2="12" y2="3"></line>
              <line x1="20" y1="21" x2="20" y2="16"></line>
              <line x1="20" y1="12" x2="20" y2="3"></line>
              <line x1="1" y1="14" x2="7" y2="14"></line>
              <line x1="9" y1="8" x2="15" y2="8"></line>
              <line x1="17" y1="16" x2="23" y2="16"></line>
              {!showControls && <line x1="2" y1="22" x2="22" y2="2" stroke="currentColor" strokeWidth="2"></line>}
            </svg>
          </button>

          <button
            className={`p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-primary ${showDetections ? 'bg-secondary hover:bg-secondary/80 text-secondary-foreground' : 'bg-primary/20 hover:bg-primary/30 text-primary'}`}
            onClick={() => setShowDetections(v => !v)}
            title={showDetections ? t('live.hideAllDetectionOverlays') : t('live.showAllDetectionOverlays')}
          >
            {/* Eye icon for detection overlay toggle */}
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
              {!showDetections && <line x1="2" y1="22" x2="22" y2="2" stroke="currentColor" strokeWidth="2"></line>}
            </svg>
          </button>

          {!isWorkspaceMode && orderedStreams.length > 1 && (
            <button
              className={`p-2 rounded-full focus:outline-none focus:ring-2 focus:ring-primary ${reorderMode ? 'bg-primary text-primary-foreground hover:bg-primary/90' : 'bg-secondary hover:bg-secondary/80 text-secondary-foreground'}`}
              onClick={toggleReorderMode}
              title={reorderMode ? t('live.exitReorderMode') : t('live.dragToReorderCameras')}
            >
              {/* Drag-handle dots icon */}
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
                   fill="currentColor" stroke="none">
                <circle cx="9"  cy="5"  r="1.6"/><circle cx="15" cy="5"  r="1.6"/>
                <circle cx="9"  cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>
                <circle cx="9"  cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/>
              </svg>
            </button>
          )}

          {reorderMode && (
            <button
              className="p-2 rounded-full bg-secondary hover:bg-secondary/80 text-secondary-foreground focus:outline-none focus:ring-2 focus:ring-primary"
              onClick={resetOrder}
              title={t('live.resetCameraOrder')}
            >
              {/* Reset / circular-arrow icon */}
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24"
                   fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1 4 1 10 7 10"/>
                <path d="M3.51 15a9 9 0 1 0 .49-4.95"/>
              </svg>
            </button>
          )}

          <button
            id="fullscreen-btn"
            className="p-2 rounded-full bg-secondary hover:bg-secondary/80 text-secondary-foreground focus:outline-none focus:ring-2 focus:ring-primary"
            onClick={() => toggleFullscreen()}
            title={isWebRTC ? t('live.toggleFullscreen') : t('timeline.fullscreen')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none"
                 stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path
                d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path>
            </svg>
          </button>
        </div>
      </div>

      <div className="live-workspace-shell">
        <div className="live-workspace-main">
          <div className="live-workspace-header">
            {/* Layout tabs (Nx Witness): one per open layout, * = unsaved changes */}
            <div className="live-layout-tabs" role="tablist" aria-label="Open layouts" data-testid="layout-tabs">
              {layoutTabs.map((tab) => {
                const isActive = tab.key === activeTabKey;
                const tabLayout = tab.layoutId ? liveLayouts.layouts.find((layout) => layout.id === tab.layoutId) : null;
                const name = tabLayout?.name || tab.title || 'New Layout';
                const isDraft = isActive ? isActiveDraft : Boolean(tab.draft);
                return (
                  <div
                    key={tab.key}
                    role="tab"
                    tabIndex={isActive ? 0 : -1}
                    aria-selected={isActive}
                    data-tab-key={tab.key}
                    data-layout-id={tab.layoutId || ''}
                    className={`live-layout-tab ${isActive ? 'is-active' : ''} ${isDraft ? 'is-draft' : ''}`}
                    title={isDraft ? `${name} (unsaved changes)` : name}
                    onClick={() => switchToLayoutTab(tab.key)}
                    onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); closeLayoutTab(tab.key); } }}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!isActive) switchToLayoutTab(tab.key);
                      setTabContextMenu({ x: Math.min(event.clientX, window.innerWidth - 220), y: event.clientY + 4 });
                    }}
                  >
                    {tabLayout?.locked && (
                      <svg className="live-layout-tab-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-label="Locked">
                        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" strokeWidth="1.4" />
                        <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" strokeWidth="1.4" />
                      </svg>
                    )}
                    <span className="live-layout-tab-name">{name}</span>
                    {isDraft && <span className="live-layout-tab-draft" aria-label="Unsaved changes">*</span>}
                    <button
                      type="button"
                      className="live-layout-tab-close"
                      aria-label={`Close ${name}`}
                      title="Close"
                      onClick={(event) => { event.stopPropagation(); closeLayoutTab(tab.key); }}
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                        <path strokeLinecap="round" strokeWidth="1.8" d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
                      </svg>
                    </button>
                  </div>
                );
              })}
              <button
                type="button"
                className="live-layout-tab-new"
                data-testid="layout-tab-new"
                aria-label="New layout tab"
                title="New layout"
                onClick={() => openNewLayoutTab()}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeWidth="1.8" d="M8 3.5v9M3.5 8h9" />
                </svg>
              </button>
            </div>
            <div className="live-workspace-header-actions">
              {singleCameraMode ? (
                <span className="live-layout-status">Single camera{singleCameraStream ? ` · ${singleCameraStream.name}` : ''}</span>
              ) : isSharedLayout ? (
                <span className="live-layout-status" title="Shared with you: view only. Use Save As to make your own copy.">View only</span>
              ) : isLockedLayout ? (
                <span className="live-layout-status" title="Unlock the layout (menu) to change it">Locked</span>
              ) : isActiveDraft ? (
                <div className="live-layout-draft-actions" data-testid="layout-draft-actions">
                  <span className="live-layout-status is-draft">Draft · unsaved changes</span>
                  <button type="button" className="live-layout-discard" data-testid="layout-discard" onClick={() => discardActiveTabChanges()}>
                    Discard
                  </button>
                  <button type="button" className="live-layout-save" data-testid="layout-save" title="Save (Ctrl+S)" onClick={() => saveCurrentWorkspaceLayout()}>
                    Save
                  </button>
                </div>
              ) : null}
              <div className="live-workspace-layout-control">
                <span className="live-workspace-layout-label">Layout:</span>
                <div className="live-workspace-preset-wrap">
                  <button
                    type="button"
                    className="live-workspace-preset-button"
                    onClick={() => {
                      setWorkspaceMenuOpen(false);
                      setLayoutPresetMenuOpen((open) => !open);
                    }}
                    disabled={workspaceLocked}
                    title={workspaceLocked ? lockedReasonRef.current : 'Choose an empty grid layout'}
                    aria-label="Choose empty grid layout"
                    aria-expanded={layoutPresetMenuOpen}
                  >
                    <svg className="live-workspace-preset-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <rect x="3" y="3" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.3" />
                      <rect x="9" y="3" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.3" />
                      <rect x="3" y="9" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.3" />
                      <rect x="9" y="9" width="4" height="4" rx="0.6" stroke="currentColor" strokeWidth="1.3" />
                    </svg>
                    <span>{workspacePresetLabel}</span>
                    <svg className="live-workspace-preset-chevron" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  {layoutPresetMenuOpen && (
                    <div className="live-workspace-preset-menu" role="menu">
                      {WORKSPACE_LAYOUT_PRESETS.map((preset) => (
                        <button
                          key={preset.label}
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setLayoutPresetMenuOpen(false);
                            applyWorkspacePreset(preset);
                          }}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="live-workspace-menu-wrap">
                <button
                  type="button"
                  className="live-workspace-menu-button"
                  aria-label="Open workspace layout menu"
                  aria-expanded={workspaceMenuOpen}
                  onClick={() => {
                    setLayoutPresetMenuOpen(false);
                    setWorkspaceMenuOpen((open) => !open);
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <circle cx="8" cy="3.25" r="1.2" />
                    <circle cx="8" cy="8" r="1.2" />
                    <circle cx="8" cy="12.75" r="1.2" />
                  </svg>
                </button>
                {workspaceMenuOpen && (
                  <div className="live-workspace-menu" role="menu">
                    <div className="live-workspace-menu-group" role="group" aria-label="Cell shape">
                      <span className="live-workspace-menu-label">Cell shape</span>
                      <div className="live-workspace-menu-options">
                        {CELL_ASPECT_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            role="menuitemradio"
                            aria-checked={layoutCellAspect === option}
                            data-cell-aspect={option}
                            disabled={workspaceLocked}
                            title={option === 'auto' ? 'Same shape as the first camera' : `${option} cells`}
                            className={layoutCellAspect === option ? 'is-active' : ''}
                            onClick={() => { captureTileRects(); setLayoutCellAspect(option); setWorkspaceMenuOpen(false); }}
                          >
                            {option === 'auto' ? 'Auto' : option}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="live-workspace-menu-group" role="group" aria-label="Cell spacing">
                      <span className="live-workspace-menu-label">Cell spacing (Ctrl + wheel)</span>
                      <div className="live-workspace-menu-options is-four">
                        {CELL_SPACING_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            role="menuitemradio"
                            aria-checked={layoutCellSpacing === option}
                            data-cell-spacing={option}
                            disabled={workspaceLocked}
                            className={layoutCellSpacing === option ? 'is-active' : ''}
                            onClick={() => { captureTileRects(); setLayoutCellSpacing(option); setWorkspaceMenuOpen(false); }}
                          >
                            {option.charAt(0).toUpperCase() + option.slice(1)}
                          </button>
                        ))}
                      </div>
                    </div>
                    {isSharedLayout && (
                      <div className="live-workspace-menu-note" data-testid="layout-shared-note">
                        Shared by {activeLayout?.ownerName || 'another user'} (view only). Use Save As to make your own copy.
                      </div>
                    )}
                    {activeLayoutId && !isSharedLayout && (
                      <button type="button" role="menuitem" data-testid="layout-lock-toggle" onClick={() => { setWorkspaceMenuOpen(false); toggleActiveLayoutLock(); }}>
                        {isLockedLayout ? 'Unlock Layout' : 'Lock Layout'}
                      </button>
                    )}
                    {activeLayoutId && !isSharedLayout && isAdminUser && (
                      <button type="button" role="menuitem" data-testid="layout-share" onClick={() => { setWorkspaceMenuOpen(false); openShareDialog(); }}>
                        Share Layout…{activeLayout?.sharedWith?.length ? ` (${activeLayout.sharedWith.length})` : ''}
                      </button>
                    )}
                    {activeLayoutId && !isSharedLayout && (
                      <>
                        <button type="button" role="menuitem" data-testid="layout-background-set" disabled={isLockedLayout} onClick={() => { setWorkspaceMenuOpen(false); backgroundInputRef.current?.click(); }}>
                          {activeLayout?.background ? 'Change Background…' : 'Set Background…'}
                        </button>
                        {activeLayout?.background && (
                          <div className="live-workspace-menu-group" role="group" aria-label="Background opacity">
                            <span className="live-workspace-menu-label">Background</span>
                            <div className="live-workspace-menu-options">
                              {[0.3, 0.6, 1].map((opacity) => (
                                <button
                                  key={opacity}
                                  type="button"
                                  role="menuitemradio"
                                  data-background-opacity={opacity}
                                  aria-checked={Math.abs((activeLayout.background.opacity || 0.6) - opacity) < 0.01}
                                  className={Math.abs((activeLayout.background.opacity || 0.6) - opacity) < 0.01 ? 'is-active' : ''}
                                  disabled={isLockedLayout}
                                  onClick={() => updateActiveLayout({ background: { ...activeLayout.background, opacity } })}
                                >
                                  {Math.round(opacity * 100)}%
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                        {activeLayout?.background && (
                          <button type="button" role="menuitem" data-testid="layout-background-remove" disabled={isLockedLayout} onClick={() => { setWorkspaceMenuOpen(false); removeLayoutBackground(); }}>
                            Remove Background
                          </button>
                        )}
                      </>
                    )}
                    <button type="button" role="menuitem" disabled={workspaceLocked} onClick={() => { setWorkspaceMenuOpen(false); saveCurrentWorkspaceLayout(); }}>Save Layout</button>
                    <button type="button" role="menuitem" onClick={() => {
                      setWorkspaceMenuOpen(false);
                      const name = window.prompt('Layout name', activeLayout?.name ? `${activeLayout.name} Copy` : '');
                      if (name) saveCurrentWorkspaceAsLayout(name);
                    }}>Save As</button>
                    <button type="button" role="menuitem" disabled={!activeLayoutId || isSharedLayout || isLockedLayout} onClick={() => { setWorkspaceMenuOpen(false); renameCurrentWorkspaceLayout(); }}>Rename Layout</button>
                    <button type="button" role="menuitem" disabled={!activeLayoutId || isSharedLayout || isLockedLayout} onClick={() => { setWorkspaceMenuOpen(false); deleteCurrentWorkspaceLayout(); }}>Delete Layout</button>
                    <button type="button" role="menuitem" disabled={workspaceLocked} onClick={() => { setWorkspaceMenuOpen(false); resetCurrentWorkspaceLayout(); }}>Reset Layout</button>
                  </div>
                )}
              </div>
            </div>
          </div>

        <input
          ref={backgroundInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          data-testid="layout-background-file"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) uploadLayoutBackground(file);
          }}
        />
        {tabContextMenu && (
          <div
            className="sidebar-camera-context-menu live-tile-context-menu"
            role="menu"
            data-testid="layout-tab-menu"
            style={{ left: `${tabContextMenu.x}px`, top: `${tabContextMenu.y}px` }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <button type="button" role="menuitem" disabled={workspaceLocked} onClick={() => { setTabContextMenu(null); saveCurrentWorkspaceLayout(); }}>
              Save Layout
              <span style={{ marginLeft: 'auto', opacity: 0.6, fontWeight: 500 }}>Ctrl+S</span>
            </button>
            <button type="button" role="menuitem" onClick={() => {
              setTabContextMenu(null);
              const name = window.prompt('Layout name', activeLayout?.name ? `${activeLayout.name} Copy` : activeTabTitleRef.current);
              if (name) saveCurrentWorkspaceAsLayout(name);
            }}>Save Layout As…</button>
            <button type="button" role="menuitem" disabled={!isActiveDraft} onClick={() => { setTabContextMenu(null); discardActiveTabChanges(); }}>Discard Changes</button>
            <button type="button" role="menuitem" onClick={() => { setTabContextMenu(null); openNewLayoutTab(); }}>New Layout Tab</button>
            <button type="button" role="menuitem" onClick={() => { setTabContextMenu(null); closeLayoutTab(activeTabKey); }}>Close</button>
            <button
              type="button"
              role="menuitem"
              disabled={layoutTabs.length < 2}
              onClick={() => {
                setTabContextMenu(null);
                // Tabs with unsaved changes stay open
                const tabs = tabsWithCurrentDraft();
                setLayoutTabs(tabs.filter((tab) => tab.key === activeTabKey || tab.draft));
              }}
            >
              Close Other Tabs
            </button>
          </div>
        )}
        {closeTabPrompt && (
          <div className="live-share-dialog-backdrop" role="presentation" onClick={() => setCloseTabPrompt(null)}>
            <div className="live-share-dialog" role="dialog" aria-modal="true" aria-labelledby="close-tab-title" data-testid="close-tab-dialog" onClick={(event) => event.stopPropagation()}>
              <h3 id="close-tab-title">Save changes to "{activeLayout?.name || activeTabTitleRef.current || 'New Layout'}"?</h3>
              <p>This layout has unsaved changes. If you close it without saving, they are lost.</p>
              <div className="live-share-actions">
                <button type="button" className="btn-secondary" data-testid="close-tab-cancel" onClick={() => setCloseTabPrompt(null)}>Cancel</button>
                <button type="button" className="btn-secondary" data-testid="close-tab-discard" onClick={() => {
                  const { key } = closeTabPrompt;
                  setCloseTabPrompt(null);
                  closeLayoutTab(key, { force: true });
                }}>Don't Save</button>
                <button type="button" className="btn-primary" data-testid="close-tab-save" onClick={async () => {
                  const { key } = closeTabPrompt;
                  const saved = await saveCurrentWorkspaceLayout();
                  if (!saved) return;
                  setCloseTabPrompt(null);
                  closeLayoutTab(key, { force: true });
                }}>Save</button>
              </div>
            </div>
          </div>
        )}
        {shareDialogOpen && (
          <div className="live-share-dialog-backdrop" role="presentation" onClick={() => setShareDialogOpen(false)}>
            <div className="live-share-dialog" role="dialog" aria-modal="true" aria-labelledby="live-share-title" onClick={(event) => event.stopPropagation()}>
              <h3 id="live-share-title">Share "{activeLayout?.name}"</h3>
              <p>People you share with see this layout in their list. They can watch it but not change it.</p>
              {shareUsers.length === 0 ? (
                <p className="live-share-empty">There are no other users yet. Add users under Users.</p>
              ) : (
                <ul>
                  {shareUsers.map((user) => (
                    <li key={user.id}>
                      <label>
                        <input
                          type="checkbox"
                          data-share-user={user.username}
                          checked={shareSelection.includes(Number(user.id))}
                          onChange={(event) => {
                            const id = Number(user.id);
                            setShareSelection((previous) => (event.currentTarget.checked
                              ? [...previous.filter((value) => value !== id), id]
                              : previous.filter((value) => value !== id)));
                          }}
                        />
                        <span>{user.username}</span>
                        <span className="live-share-role">{user.role_name || ''}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <div className="live-share-actions">
                <button type="button" className="btn-secondary" onClick={() => setShareDialogOpen(false)}>Cancel</button>
                <button type="button" className="btn-primary" data-testid="layout-share-save" onClick={saveShareSelection}>Save</button>
              </div>
            </div>
          </div>
        )}
        {tileContextMenu && (
          <div
            className="sidebar-camera-context-menu live-tile-context-menu"
            role="menu"
            data-testid="tile-context-menu"
            style={{ left: `${tileContextMenu.x}px`, top: `${tileContextMenu.y}px` }}
            onContextMenu={(event) => event.preventDefault()}
          >
            <div className="sidebar-camera-context-title">
              {tileContextMenu.ids.length === 1
                ? (workspaceTiles.find((tile) => tile.instanceId === tileContextMenu.ids[0])?.cameraId || '1 camera selected')
                : `${tileContextMenu.ids.length} cameras selected`}
            </div>
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              data-testid="tile-context-remove"
              disabled={workspaceLocked}
              title={workspaceLocked ? lockedReasonRef.current : undefined}
              onClick={() => removeSelectedTiles(tileContextMenu.ids)}
            >
              {tileContextMenu.ids.length === 1 ? 'Remove from layout' : `Remove ${tileContextMenu.ids.length} cameras from layout`}
            </button>
            {tileContextMenu.ids.length < workspaceTiles.filter((tile) => tile.type !== 'slot').length && (
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setSelectedTileIds(workspaceTiles.filter((tile) => tile.type !== 'slot').map((tile) => tile.instanceId));
                  setTileContextMenu(null);
                }}
              >
                Select all
                <span style={{ marginLeft: 'auto', opacity: 0.6, fontWeight: 500 }}>Ctrl+A</span>
              </button>
            )}
          </div>
        )}
        <div
          ref={sceneViewportRef}
          className={`live-scene-viewport ${isWorkspaceMode && sceneZoom.scale > 1.001 ? 'is-zoomed' : ''} ${gridOverlay ? 'is-editing-scene' : ''}`}
          onPointerDown={(event) => {
            if (!isWorkspaceMode) return;
            const onEmptySpace = !event.target.closest('.live-workspace-tile, .live-workspace-slot, button, input, select, textarea, .live-tile-context-menu, .live-scene-zoom-badge');
            const onCamera = Boolean(event.target.closest('.live-workspace-tile')) &&
              !event.target.closest('button, input, select, textarea, .stream-controls, .live-workspace-resize-handle');
            if (event.button === 0 && (onEmptySpace || (event.shiftKey && onCamera))) {
              // Drag a box to select cameras (Shift also starts it over a camera).
              // Ctrl/Shift keep the cameras already selected.
              startSelectionBox(event);
              return;
            }
            // Right or middle drag on empty space moves around a zoomed scene
            if (!onEmptySpace || sceneZoomRef.current.scale <= 1.001 || (event.button !== 1 && event.button !== 2)) return;
            event.preventDefault();
            const startX = event.clientX;
            const startY = event.clientY;
            const startZoom = sceneZoomRef.current;
            let panned = false;
            sceneViewportRef.current?.classList.add('is-panning');
            const move = (moveEvent) => {
              if (Math.abs(moveEvent.clientX - startX) + Math.abs(moveEvent.clientY - startY) > 4) panned = true;
              setSceneZoom(clampSceneZoom({
                ...startZoom,
                x: startZoom.x + (moveEvent.clientX - startX),
                y: startZoom.y + (moveEvent.clientY - startY),
              }, sceneViewportRef.current));
            };
            const up = () => {
              sceneViewportRef.current?.classList.remove('is-panning');
              window.removeEventListener('pointermove', move);
              window.removeEventListener('pointerup', up);
              // No browser menu after a right-drag pan
              if (panned) {
                const block = (menuEvent) => menuEvent.preventDefault();
                window.addEventListener('contextmenu', block, { capture: true, once: true });
                window.setTimeout(() => window.removeEventListener('contextmenu', block, { capture: true }), 300);
              }
            };
            window.addEventListener('pointermove', move);
            window.addEventListener('pointerup', up);
          }}
          onDblClick={(event) => {
            if (!isWorkspaceMode || event.target.closest('.live-workspace-tile, .live-workspace-slot')) return;
            setSceneZoom({ scale: 1, x: 0, y: 0 });
          }}
        >
        {isWorkspaceMode && selectionBox && (
          <div
            className="live-scene-selection-box"
            aria-hidden="true"
            data-testid="scene-selection-box"
            style={{
              left: `${selectionBox.left}px`,
              top: `${selectionBox.top}px`,
              width: `${selectionBox.width}px`,
              height: `${selectionBox.height}px`,
            }}
          />
        )}
        {isWorkspaceMode && gridOverlay && (
          <div
            className="live-scene-grid-overlay"
            aria-hidden="true"
            data-testid="scene-grid-overlay"
            style={{
              backgroundSize: `${gridOverlay.cellW}px ${gridOverlay.cellH}px`,
              backgroundPosition: `${gridOverlay.left}px ${gridOverlay.top}px`,
            }}
          />
        )}
        {isWorkspaceMode && gridOverlay && snapPreview && (
          // Cells the camera will take: green where it can go, red where it cannot (Nx Witness)
          <div
            className={`live-scene-snap-preview ${snapPreview.valid ? '' : 'is-invalid'} ${snapPreview.valid && snapPreview.blocked ? 'is-blocked' : ''}`}
            aria-hidden="true"
            data-testid="scene-snap-preview"
            data-cells={`${snapPreview.x},${snapPreview.y},${snapPreview.w},${snapPreview.h}`}
            style={{
              left: `${gridOverlay.left + snapPreview.x * gridOverlay.cellW}px`,
              top: `${gridOverlay.top + snapPreview.y * gridOverlay.cellH}px`,
              width: `${snapPreview.w * gridOverlay.cellW}px`,
              height: `${snapPreview.h * gridOverlay.cellH}px`,
            }}
          />
        )}
        <div
          id="video-grid"
          ref={workspaceGridRef}
          className={`video-container ${isWorkspaceMode ? 'is-workspace-grid' : gridHasEmptySlots ? 'is-partial-grid' : 'is-filled-grid'} ${visibleWorkspaceTileCount === 1 ? 'is-single-camera' : ''} ${singleCameraMode ? 'is-single-camera-view' : ''} ${isMobileViewport && isWorkspaceMode && !singleCameraMode ? 'is-mobile-workspace-stack' : ''} ${movingTileId ? 'is-moving-tile' : ''}`}
          style={{
            '--grid-cols': workspaceGridCols,
            '--grid-rows': workspaceGridRows,
            ...(isWorkspaceMode ? { '--tile-gap-px': `${CELL_SPACING_PX[layoutCellSpacing] ?? 8}px` } : {}),
            ...(isWorkspaceMode ? {
              transform: Math.abs(sceneZoom.scale - 1) > 0.001 ? `translate(${sceneZoom.x}px, ${sceneZoom.y}px) scale(${sceneZoom.scale})` : 'none',
              transformOrigin: '0 0',
            } : {}),
            ...(activeLayout?.background && !singleCameraMode ? {
              // Map or floor plan behind the cameras, dimmed by its opacity
              backgroundImage: `linear-gradient(rgba(0, 0, 0, ${(1 - (activeLayout.background.opacity || 0.6)).toFixed(2)}), rgba(0, 0, 0, ${(1 - (activeLayout.background.opacity || 0.6)).toFixed(2)})), url(/api/live-layouts/${encodeURIComponent(activeLayout.id)}/background?v=${activeLayout.background.version})`,
              backgroundSize: 'contain',
              backgroundPosition: 'center',
              backgroundRepeat: 'no-repeat',
              backgroundOrigin: 'content-box',
              backgroundClip: 'content-box',
              backgroundColor: '#000',
            } : {}),
          }}
          data-has-background={activeLayout?.background ? 'true' : undefined}
          onDragOver={(event) => {
            if (reorderMode || workspaceLocked) return;
            const types = Array.from(event.dataTransfer.types || []);
            if (!types.includes('application/x-oneberry-camera')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDrop={(event) => {
            if (reorderMode || workspaceLocked) return;
            const cameraNames = getDraggedCameraNames(event.dataTransfer);
            if (cameraNames.length === 0) return;
            event.preventDefault();
            const placement = getWorkspaceGridPoint(event);
            cameraNames.forEach((cameraName, index) => {
              addWorkspaceTile(cameraName, index === 0 ? placement : null, { autoFit: false });
            });
          }}
        >
          {isLoadingStreams ? (
              <div className="flex justify-center items-center col-span-full row-span-full h-64 w-full" style={{ pointerEvents: 'none', zIndex: 1 }}>
                <div className="flex flex-col items-center justify-center py-8">
                <div
                  className="inline-block animate-spin rounded-full border-4 border-secondary border-t-primary w-16 h-16"></div>
                <p className="mt-4 text-muted-foreground">{t('live.loadingStreams')}</p>
              </div>
            </div>
          ) : isLoading ? (
            <div
                className="flex justify-center items-center col-span-full row-span-full h-64 w-full"
                style={{
                  pointerEvents: 'none',
                  position: 'relative',
                  zIndex: 1
                }}
            >
              <div className="flex flex-col items-center justify-center py-8">
                <div
                  className="inline-block animate-spin rounded-full border-4 border-secondary border-t-primary w-16 h-16"></div>
                <p className="mt-4 text-muted-foreground">{t('live.loadingStreams')}</p>
              </div>
            </div>
          ) : (streamsError) ? (
            <LiveEmptyState
              t={t}
              title={t('live.unableToLoadCameraViews')}
              message={t('live.errorLoadingStreams', { message: streamsError.message })}
              actionOnClick={() => window.location.reload()}
              actionLabel={t('common.retry')}
            />
          ) : streams.length === 0 ? (
            <LiveEmptyState
              t={t}
              title={t('live.noCameraViewsTitle')}
              message={t('live.noCameraViewsMessage')}
              actionHref="streams.html"
              actionLabel={t('live.configureStreams')}
              secondaryText={t('live.noCameraViewsSecondary')}
            />
          ) : isWorkspaceMode && workspaceTiles.length === 0 ? (
            <LiveEmptyState
              t={t}
              title={t('live.emptyWorkspaceTitle')}
              message={t('live.emptyWorkspaceMessage')}
              actionHref="streams.html"
              actionLabel={t('live.manageCameras')}
              secondaryText={t('live.emptyWorkspaceSecondary')}
            />
          ) : !isWorkspaceMode && streamsToShow.length === 0 ? (
            <LiveEmptyState
              t={t}
              title={t('live.noVisibleCameraViewsTitle')}
              message={t('live.noVisibleCameraViewsMessage')}
              secondaryText={t('live.noVisibleCameraViewsSecondary')}
            />
          ) : (
            <>
              {(isWorkspaceMode ? workspaceTiles : streamsToShow).map((item, index) => {
                const workspaceTile = isWorkspaceMode ? item : null;
                const isWorkspaceSlot = isWorkspaceMode && workspaceTile?.type === 'slot';
                const stream = isWorkspaceMode ? streamByName.get(workspaceTile?.cameraId) : item;
                const tileInstanceId = isWorkspaceMode ? workspaceTile?.instanceId : '';
                const isSingleCameraActiveTile = singleCameraMode && !isWorkspaceSlot && workspaceTile?.cameraId === singleCameraView?.selectedCameraId;
                const isSingleCameraInactiveTile = singleCameraMode && !isSingleCameraActiveTile;
                if (isWorkspaceSlot) {
                  return (
                    <div
                      key={tileInstanceId}
                      data-tile-id={tileInstanceId}
                      className={`live-workspace-slot ${isSingleCameraInactiveTile ? 'is-single-camera-inactive' : ''} ${tileDropTargetId === tileInstanceId ? 'is-drop-target' : ''}`}
                      style={{
                        gridColumn: `${Math.min(workspaceGridCols, workspaceTile.x + 1)} / span ${Math.max(1, Math.min(workspaceGridCols - workspaceTile.x, workspaceTile.w || DEFAULT_WORKSPACE_TILE_W))}`,
                        gridRow: `${Math.min(workspaceGridRows, workspaceTile.y + 1)} / span ${Math.max(1, Math.min(workspaceGridRows - workspaceTile.y, workspaceTile.h || DEFAULT_WORKSPACE_TILE_H))}`,
                      }}
                      onDragOver={(event) => {
                        if (workspaceLocked) return;
                        const types = Array.from(event.dataTransfer.types || []);
                        if (!types.includes('application/x-oneberry-camera')) return;
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = 'copy';
                      }}
                      onDrop={(event) => {
                        if (workspaceLocked) return;
                        const cameraNames = getDraggedCameraNames(event.dataTransfer);
                        if (cameraNames.length === 0) return;
                        event.preventDefault();
                        event.stopPropagation();
                        cameraNames.forEach((cameraName, cameraIndex) => {
                          addWorkspaceTile(cameraName, cameraIndex === 0 ? { x: workspaceTile.x, y: workspaceTile.y } : null, { autoFit: false });
                        });
                      }}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M15 10l4.55-2.28A1 1 0 0 1 21 8.62v6.76a1 1 0 0 1-1.45.9L15 14" />
                        <rect x="3" y="6" width="12" height="12" rx="2.2" strokeWidth="1.8" />
                      </svg>
                      <span>{t('live.dropCameraHere')}</span>
                    </div>
                  );
                }
                if (!stream) return null;
                const VideoCell = isWebRTC ? WebRTCVideoCell : useMSE ? MSEVideoCell : HLSVideoCell;
                const initDelay = isWorkspaceMode
                  ? 0
                  : getLiveInitDelay({
                    isWebRTC,
                    useMSE,
                    go2rtcAvailable,
                    index,
                    totalStreams: streamsToShow.length,
                  });
                // Global index in orderedStreams for drag-and-drop (pagination offset)
                const globalIndex = currentPage * maxStreams + index;

                return (
                  <div
                    key={tileInstanceId || stream.name}
                    data-tile-id={tileInstanceId || undefined}
                    title={stream.name}
                    className={`live-workspace-tile ${removingTileIds.has(tileInstanceId) ? 'is-removing' : ''} ${isSingleCameraActiveTile ? 'is-single-camera-active' : ''} ${isSingleCameraInactiveTile ? 'is-single-camera-inactive' : ''} ${tileInstanceId && selectedTileIds.includes(tileInstanceId) ? 'is-selected' : ''} ${tileInstanceId && movingTileId === tileInstanceId ? 'is-moving' : ''} ${tileInstanceId && resizingTileId === tileInstanceId ? 'is-resizing' : ''} ${tileInstanceId && tileDropTargetId === tileInstanceId ? 'is-drop-target' : ''}`}
                    style={{
                      position: 'relative',
                      ...(isSingleCameraActiveTile ? {
                        gridColumn: '1 / -1',
                        gridRow: '1 / -1',
                      } : isWorkspaceMode && workspaceTile ? {
                        gridColumn: `${Math.min(workspaceGridCols, workspaceTile.x + 1)} / span ${Math.max(1, Math.min(workspaceGridCols - workspaceTile.x, workspaceTile.w || DEFAULT_WORKSPACE_TILE_W))}`,
                        gridRow: `${Math.min(workspaceGridRows, workspaceTile.y + 1)} / span ${Math.max(1, Math.min(workspaceGridRows - workspaceTile.y, workspaceTile.h || DEFAULT_WORKSPACE_TILE_H))}`,
                      } : {}),
                    }}
                    draggable={!singleCameraMode && !isWorkspaceMode && reorderMode}
                    onDragStart={!isWorkspaceMode && reorderMode ? () => handleDragStart(globalIndex) : undefined}
                    onDragOver={!isWorkspaceMode && reorderMode ? (e) => handleDragOver(e, globalIndex) : undefined}
                    onDrop={!isWorkspaceMode && reorderMode ? handleDrop : undefined}
                    onDragEnd={!isWorkspaceMode && reorderMode ? handleDragEnd : undefined}
                    onPointerDown={!singleCameraMode && isWorkspaceMode && workspaceTile ? (event) => startWorkspacePointer(event, workspaceTile, 'move') : undefined}
                    onClick={!singleCameraMode && isWorkspaceMode && tileInstanceId ? (event) => selectTileFromClick(event, tileInstanceId) : undefined}
                    onContextMenu={!singleCameraMode && isWorkspaceMode && tileInstanceId ? (event) => openTileContextMenu(event, tileInstanceId) : undefined}
                  >
                    {!isWorkspaceMode && reorderMode && (
                      <div
                        style={{
                          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
                          background: 'rgba(0,0,0,0.55)', color: '#fff',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          padding: '6px 8px', cursor: 'grab', fontSize: '13px', gap: '6px',
                          userSelect: 'none',
                        }}
                      >
                        {/* Drag handle bars icon */}
                        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                             fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/>
                        </svg>
                        {t('live.dragToReorder')}
                      </div>
                    )}
                    <div
                      className={`live-tile-frame ${isWorkspaceMode && !isMobileViewport ? 'is-fitted' : ''}`}
                      style={(() => {
                        const aspect = isWorkspaceMode && !isMobileViewport ? getCameraAspect(stream.name) : null;
                        return aspect ? {
                          width: `min(100cqw, calc(100cqh * ${aspect.toFixed(4)}))`,
                          height: `min(100cqh, calc(100cqw / ${aspect.toFixed(4)}))`,
                        } : undefined;
                      })()}
                    >
                    {isWorkspaceMode && tileInstanceId && !workspaceLocked && !singleCameraMode && (
                      <button
                        type="button"
                        className="live-workspace-tile-close"
                        aria-label={`Remove ${stream.name} tile`}
                        title={`Remove ${stream.name}`}
                        onClick={() => removeWorkspaceTile(tileInstanceId)}
                      >
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4l8 8M12 4l-8 8" />
                        </svg>
                      </button>
                    )}
                    {isWorkspaceMode && workspaceTile && !workspaceLocked && !isMobileViewport && !singleCameraMode && (
                      // Resize from the corners of the picture, like Nx Witness
                      ['ne', 'se', 'sw', 'nw'].map((handle) => (
                        <span
                          key={handle}
                          className={`live-workspace-resize-handle is-${handle}`}
                          aria-hidden="true"
                          onPointerDown={(event) => startWorkspacePointer(event, workspaceTile, 'resize', handle)}
                        />
                      ))
                    )}
                    <VideoCell
                      stream={stream}
                      onToggleFullscreen={toggleStreamFullscreen}
                      streamId={stream.name}
                      initDelay={initDelay}
                      showLabels={showLabels}
                      showControls={showControls}
                      globalShowDetections={showDetections}
                      isPageFullscreen={isFullscreen}
                      forcedAspectRatio={cameraDisplay[stream.name]?.aspectRatio || 'auto'}
                      onVideoDimensions={handleVideoDimensions}
                      itemQuality={workspaceTile ? workspaceTile.quality : (classicItemQuality[stream.name] || 'auto')}
                      onItemQualityChange={(quality) => setTileItemQuality(tileInstanceId, stream.name, quality)}
                      isOnlyItem={singleCameraMode || streamsToShow.length === 1}
                    />
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
        {isWorkspaceMode && Math.abs(sceneZoom.scale - 1) > 0.001 && (
          <div className="live-scene-zoom-badge" data-testid="scene-zoom-badge">
            <span>{Math.round(sceneZoom.scale * 100)}%</span>
            <button type="button" onClick={() => setSceneZoom({ scale: 1, x: 0, y: 0 })}>Fit</button>
          </div>
        )}
        </div>

        {!isWebRTC && isFullscreen && isSingleStream && selectedStream && (
          <FullscreenTimelineOverlay
            streamName={selectedStream}
            isVisible={true}
            mode="floating"
            playbackTimestamp={null}
          />
        )}

        {!isWorkspaceMode && !isSingleStream && orderedStreams.length > maxStreams ? (
          <div className="pagination-controls flex justify-center items-center space-x-4 mt-4">
            <button
              className="btn-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => {
                console.log('Changing to previous page');
                setCurrentPage(Math.max(0, currentPage - 1));
              }}
              disabled={currentPage === 0}
            >
              {t('common.previous')}
            </button>

            <span className="text-foreground">
              {t('live.pageOf', { current: currentPage + 1, total: orderedTotalPages })}
            </span>

            <button
              className="btn-primary focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={() => {
                console.log('Changing to next page');
                setCurrentPage(Math.min(orderedTotalPages - 1, currentPage + 1));
              }}
              disabled={currentPage >= orderedTotalPages - 1}
            >
              {t('common.next')}
            </button>
          </div>
        ) : null}
      </div>
      </div>
    </section>
  );
}
