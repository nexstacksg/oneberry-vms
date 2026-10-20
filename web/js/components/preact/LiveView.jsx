/**
 * LightNVR Web Interface LiveView Component
 * Preact component for the HLS live view page
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'preact/hooks';
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
import { pickLiveLayoutExtras } from '../../utils/live-layout-extras.js';
import { validateSession } from '../../utils/auth-utils.js';
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
const WORKSPACE_GRID_COLS = 48;
// Same as the columns, so 2x2, 3x3, 4x4, 6x6 and 8x8 split into equal rows
// (cells keep the layout's cell shape). Older layouts saved as 48x27 are scaled.
const WORKSPACE_GRID_ROWS = 48;
const DEFAULT_WORKSPACE_TILE_W = 24;
const DEFAULT_WORKSPACE_TILE_H = 24;
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
function getGridContentRect(grid) {
  const rect = grid.getBoundingClientRect();
  const styles = window.getComputedStyle(grid);
  const left = Number.parseFloat(styles.paddingLeft) || 0;
  const right = Number.parseFloat(styles.paddingRight) || 0;
  const top = Number.parseFloat(styles.paddingTop) || 0;
  const bottom = Number.parseFloat(styles.paddingBottom) || 0;
  return {
    left: rect.left + left,
    top: rect.top + top,
    width: Math.max(1, rect.width - left - right),
    height: Math.max(1, rect.height - top - bottom),
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
  const count = workspaceTiles.length;
  if (count === 0) return [];

  const [layoutCols, layoutRows] = computeOptimalGrid(count);
  return workspaceTiles.map((tile, index) => {
    const col = index % layoutCols;
    const row = Math.floor(index / layoutCols);
    const x = Math.floor((col * WORKSPACE_GRID_COLS) / layoutCols);
    const y = Math.floor((row * WORKSPACE_GRID_ROWS) / layoutRows);
    const nextX = Math.floor(((col + 1) * WORKSPACE_GRID_COLS) / layoutCols);
    const nextY = Math.floor(((row + 1) * WORKSPACE_GRID_ROWS) / layoutRows);
    return normalizeWorkspaceBounds({
      ...tile,
      x,
      y,
      w: Math.max(1, nextX - x),
      h: Math.max(1, nextY - y),
    }, WORKSPACE_GRID_COLS, WORKSPACE_GRID_ROWS);
  });
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
  const layoutRows = Math.max(1, preset?.rows || 1);
  const count = Math.max(1, preset?.count || layoutCols * layoutRows);

  return Array.from({ length: count }, (_, index) => {
    const col = index % layoutCols;
    const row = Math.floor(index / layoutCols);
    const x = Math.floor((col * WORKSPACE_GRID_COLS) / layoutCols);
    const y = Math.floor((row * WORKSPACE_GRID_ROWS) / layoutRows);
    const nextX = Math.floor(((col + 1) * WORKSPACE_GRID_COLS) / layoutCols);
    const nextY = Math.floor(((row + 1) * WORKSPACE_GRID_ROWS) / layoutRows);
    return normalizeWorkspaceBounds(createWorkspaceSlot({
      id: `slot-${preset.count}-${index + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      x,
      y,
      w: Math.max(1, nextX - x),
      h: Math.max(1, nextY - y),
    }), WORKSPACE_GRID_COLS, WORKSPACE_GRID_ROWS);
  });
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
  const lastSavedLayoutPayloadRef = useRef('');
  const saveLayoutTimeoutRef = useRef(null);
  const workspaceGridRef = useRef(null);
  const workspacePointerRef = useRef(null);
  const workspaceTilesRef = useRef([]);
  const workspaceAutoExpandedDropRef = useRef(false);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [layoutPresetMenuOpen, setLayoutPresetMenuOpen] = useState(false);
  const [layoutEditMode, setLayoutEditMode] = useState(false);
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
    const stored = localStorage.getItem('lightnvr-show-labels');
    return stored !== null ? stored === 'true' : true;
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
  const workspaceGridCols = workspaceStarted ? WORKSPACE_GRID_COLS : cols;
  const workspaceGridRows = workspaceStarted ? WORKSPACE_GRID_ROWS : rows;

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
    data: liveLayoutsData = { layouts: [] }
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
      if (!cancelled) setIsAdminUser(session?.role === 'admin');
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
    localStorage.setItem('lightnvr-show-labels', String(showLabels));
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
  const workspaceLocked = singleCameraMode || (Boolean(activeLayoutId) && (!layoutEditMode || isSharedLayout || isLockedLayout));

  const captureCurrentLayoutState = useCallback(() => ({
    selectedLayoutId: activeLayoutId,
    workspaceTiles,
    workspaceAutoGrid,
    currentPage,
    layoutEditMode,
    hydratedLayoutId,
  }), [activeLayoutId, currentPage, hydratedLayoutId, layoutEditMode, workspaceAutoGrid, workspaceTiles]);

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
      setLayoutEditMode(previousLayoutState.layoutEditMode);
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
    lastSavedLayoutPayloadRef.current = '';
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

    const layoutAreas = [...activeLayout.tiles, ...(activeLayout.slots || [])];
    const sourceCols = activeLayout.cols || layoutAreas.reduce((max, tile) => (
      Math.max(max, (Number(tile.x) || 0) + (Number(tile.w) || 1))
    ), 1);
    const sourceRows = activeLayout.rows || layoutAreas.reduce((max, tile) => (
      Math.max(max, (Number(tile.y) || 0) + (Number(tile.h) || 1))
    ), 1);
    const tiles = activeLayout.tiles
      .filter((tile) => streamByName.has(tile.camera))
      .map((tile, index) => scaleLayoutTileToWorkspace(
        createWorkspaceTile(tile.camera, {
          ...tile,
          id: tile.id || `tile-${index + 1}`,
        }),
        sourceCols,
        sourceRows
      ));
    const slots = (activeLayout.slots || []).map((slot, index) => scaleLayoutTileToWorkspace(
      createWorkspaceSlot({
        ...slot,
        id: slot.id || `slot-${index + 1}`,
      }),
      sourceCols,
      sourceRows
    ));

    setWorkspaceTiles([...tiles, ...slots]);
    setWorkspaceStarted(true);
    setWorkspaceAutoGrid(tiles.length === 0 && slots.length === 0);
    setLayoutCellAspect(activeLayout.cellAspect || 'auto');
    setLayoutEditMode(false);
    setCurrentPage(0);

    const serializedTiles = serializeWorkspaceTilesForSave(tiles);
    const serializedSlots = serializeWorkspaceSlotsForSave(slots);
    lastSavedLayoutPayloadRef.current = JSON.stringify({
      id: activeLayout.id,
      cols: WORKSPACE_GRID_COLS,
      rows: WORKSPACE_GRID_ROWS,
      cellAspect: activeLayout.cellAspect || 'auto',
      tiles: serializedTiles,
      slots: serializedSlots,
    });
    setHydratedLayoutId(activeLayoutId);
  }, [activeLayout, activeLayoutId, hydratedLayoutId, streamByName, streams.length]);

  const getWorkspaceGridPoint = useCallback((event, fallbackIndex = workspaceTiles.length) => {
    const grid = workspaceGridRef.current;
    if (!grid) {
      return {
        x: workspaceGridCols > 0 ? fallbackIndex % workspaceGridCols : fallbackIndex,
        y: workspaceGridCols > 0 ? Math.floor(fallbackIndex / workspaceGridCols) : 0,
      };
    }

    const rect = getGridContentRect(grid);
    const styles = window.getComputedStyle(grid);
    const gap = Number.parseFloat(styles.columnGap || styles.gap || '0') || 0;
    const safeCols = Math.max(1, workspaceGridCols);
    const safeRows = Math.max(1, workspaceGridRows);
    const cellWidth = (rect.width - (gap * (safeCols - 1))) / safeCols;
    const cellHeight = (rect.height - (gap * (safeRows - 1))) / safeRows;
    const x = Math.max(0, Math.min(safeCols - 1, Math.floor((event.clientX - rect.left) / Math.max(1, cellWidth + gap))));
    const y = Math.max(0, Math.min(safeRows - 1, Math.floor((event.clientY - rect.top) / Math.max(1, cellHeight + gap))));
    return { x, y };
  }, [workspaceGridCols, workspaceGridRows, workspaceTiles.length]);

  const updateWorkspaceTile = useCallback((instanceId, updater) => {
    setWorkspaceTiles((previousTiles) => {
      const currentTile = previousTiles.find((tile) => tile.instanceId === instanceId);
      if (!currentTile) return previousTiles;

      const proposedTile = normalizeWorkspaceBounds(
        typeof updater === 'function' ? updater(currentTile) : { ...currentTile, ...updater },
        workspaceGridCols,
        workspaceGridRows
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
  }, [workspaceGridCols, workspaceGridRows]);

  const addWorkspaceTile = useCallback((cameraName, placement = null, options = {}) => {
    const cameraId = String(cameraName || '').trim();
    if (!cameraId) return;

    if (workspaceLocked && !options.force) {
      showStatusMessage('Click Edit Layout before changing this saved layout', 'error', 5000);
      return;
    }

    if (!streamByName.has(cameraId)) {
      showStatusMessage(`Camera "${cameraId}" is not available in Live View`, 'error', 5000);
      return;
    }

    const shouldAutoTile = !activeLayoutId && !placement && options.autoFit !== false;
    workspaceAutoExpandedDropRef.current = false;
    setWorkspaceStarted(true);
    setWorkspaceTiles((previousTiles) => {
      const cameraTileCount = previousTiles.filter((tile) => tile.type !== 'slot' && tile.cameraId).length;
      if (cameraTileCount >= layoutMaxItemsRef.current) {
        window.setTimeout(showLayoutFullMessage, 0);
        return previousTiles;
      }
      const candidateTile = createWorkspaceTile(cameraId);
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
            ? normalizeWorkspaceBounds({
              ...candidateTile,
              x: targetSlot.x,
              y: targetSlot.y,
              w: targetSlot.w,
              h: targetSlot.h,
            }, workspaceGridCols, workspaceGridRows)
            : tile
        ));
      }

      if (shouldAutoTile || (!placement && workspaceAutoGrid && options.autoFit !== false)) {
        return buildResponsiveWorkspaceLayout([...previousTiles, candidateTile]);
      }

      const openArea = findBestOpenWorkspaceArea(
        previousTiles,
        workspaceGridCols,
        workspaceGridRows,
        placement
      );
      const openSlot = openArea || findOpenWorkspaceSlot(
        previousTiles,
        Math.min(DEFAULT_WORKSPACE_TILE_W, workspaceGridCols),
        Math.min(DEFAULT_WORKSPACE_TILE_H, workspaceGridRows),
        workspaceGridCols,
        workspaceGridRows
      );
      const point = openArea || placement || {
        x: openSlot?.x ?? 0,
        y: openSlot?.y ?? 0,
      };
      const nextTile = normalizeWorkspaceBounds({
        ...candidateTile,
        x: point.x,
        y: point.y,
        w: openArea?.w ?? DEFAULT_WORKSPACE_TILE_W,
        h: openArea?.h ?? DEFAULT_WORKSPACE_TILE_H,
      }, workspaceGridCols, workspaceGridRows);
      const collision = findTileCollision(nextTile, previousTiles);
      if (collision) {
        if (!openSlot) {
          return insertWorkspaceTileWithBalancedSpace(
            previousTiles,
            candidateTile,
            workspaceGridCols,
            workspaceGridRows,
            placement
          );
        }
        const fallback = normalizeWorkspaceBounds(createWorkspaceTile(cameraId, {
          x: openSlot.x,
          y: openSlot.y,
          w: openSlot.w ?? DEFAULT_WORKSPACE_TILE_W,
          h: openSlot.h ?? DEFAULT_WORKSPACE_TILE_H,
        }), workspaceGridCols, workspaceGridRows);
        return [...previousTiles, fallback];
      }

      return [...previousTiles, nextTile];
    });
    if (placement) {
      setWorkspaceAutoGrid(workspaceAutoExpandedDropRef.current);
    } else if (shouldAutoTile || (workspaceAutoGrid && options.autoFit !== false)) {
      setWorkspaceAutoGrid(true);
    }
    setCurrentPage(0);
    setSelectedStream(cameraId);
  }, [activeLayoutId, streamByName, workspaceAutoGrid, workspaceGridCols, workspaceGridRows, workspaceLocked]);

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

    setActiveLayoutId('');
    setSingleCameraView(null);
    setHydratedLayoutId('');
    setLayoutEditMode(false);
    setWorkspaceStarted(true);
    setWorkspaceAutoGrid(true);
    setWorkspaceTiles(buildResponsiveWorkspaceLayout(
      availableCameraNames.map((cameraName) => createWorkspaceTile(cameraName))
    ));
    setCurrentPage(0);
    setSelectedStream(availableCameraNames[0]);
    setLayoutPresetMenuOpen(false);
    setWorkspaceMenuOpen(false);
  }, [streamByName]);

  const applyWorkspacePreset = useCallback((preset) => {
    if (workspaceLocked) {
      showStatusMessage('Click Edit Layout before changing this saved layout', 'error', 5000);
      return;
    }
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
      showStatusMessage('Click Edit Layout before changing this saved layout', 'error', 5000);
      return;
    }
    if (!instanceId || removeTimeoutsRef.current.has(instanceId)) return;

    setRemovingTileIds((previousIds) => {
      const nextIds = new Set(previousIds);
      nextIds.add(instanceId);
      return nextIds;
    });

    const timeoutId = window.setTimeout(() => {
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

  const getWorkspaceCellSize = useCallback(() => {
    const grid = workspaceGridRef.current;
    if (!grid) return { width: 1, height: 1 };

    const rect = getGridContentRect(grid);
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
    const cellSize = getWorkspaceCellSize();
    const dx = Math.round((event.clientX - state.startX) / cellSize.width);
    const dy = Math.round((event.clientY - state.startY) / cellSize.height);

    if (state.mode === 'move') {
      // Over another tile or an empty slot: drop there to swap places (Nx Witness style)
      const dropTarget = findTileAtPoint(workspaceTilesRef.current, getWorkspaceGridPoint(event), state.instanceId);
      const dropTargetId = dropTarget?.instanceId || '';
      if (dropTargetId !== state.dropTargetId) {
        state.dropTargetId = dropTargetId;
        setTileDropTargetId(dropTargetId);
      }
      if (dropTargetId) return;
      if (dx === 0 && dy === 0) return;
      setWorkspaceAutoGrid(false);
      updateWorkspaceTile(state.instanceId, {
        ...state.startTile,
        x: state.startTile.x + dx,
        y: state.startTile.y + dy,
      });
      return;
    }

    const nextTile = { ...state.startTile };
    if (state.edges.includes('e')) {
      nextTile.w = state.startTile.w + dx;
    }
    if (state.edges.includes('s')) {
      nextTile.h = state.startTile.h + dy;
    }
    if (state.edges.includes('w')) {
      nextTile.x = state.startTile.x + dx;
      nextTile.w = state.startTile.w - dx;
    }
    if (state.edges.includes('n')) {
      nextTile.y = state.startTile.y + dy;
      nextTile.h = state.startTile.h - dy;
    }
    if (dx !== 0 || dy !== 0) {
      setWorkspaceAutoGrid(false);
    }
    updateWorkspaceTile(state.instanceId, nextTile);
  }, [getWorkspaceCellSize, getWorkspaceGridPoint, updateWorkspaceTile]);

  const finishWorkspacePointer = useCallback(() => {
    const state = workspacePointerRef.current;
    if (state?.mode === 'move' && state.dropTargetId) {
      const { instanceId, dropTargetId } = state;
      setWorkspaceTiles((previousTiles) => swapTilePlaces(previousTiles, instanceId, dropTargetId));
    }
    setMovingTileId('');
    setTileDropTargetId('');
    workspacePointerRef.current = null;
    window.removeEventListener('pointermove', handleWorkspacePointerMove);
    window.removeEventListener('pointerup', finishWorkspacePointer);
    window.removeEventListener('pointercancel', finishWorkspacePointer);
  }, [handleWorkspacePointerMove]);

  const startWorkspacePointer = useCallback((event, tile, mode = 'move', edges = '') => {
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
    }
    workspacePointerRef.current = {
      mode,
      edges,
      dropTargetId: '',
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
        editing: Boolean(activeLayoutId && layoutEditMode),
      },
    }));
  }, [activeLayoutId, layoutEditMode]);

  useEffect(() => () => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent('oneberry:live-layout-edit-mode', {
      detail: { layoutId: activeLayoutId, editing: false },
    }));
  }, [activeLayoutId]);

  useEffect(() => {
    if (!activeLayoutId || !activeLayout || !workspaceStarted || hydratedLayoutId !== activeLayoutId) return;
    if (activeLayout.sharedWithMe) return;

    const tiles = serializeWorkspaceTilesForSave(workspaceTiles);
    const slots = serializeWorkspaceSlotsForSave(workspaceTiles);
    const payloadKey = JSON.stringify({
      id: activeLayoutId,
      cols: WORKSPACE_GRID_COLS,
      rows: WORKSPACE_GRID_ROWS,
      cellAspect: layoutCellAspect,
      tiles,
      slots,
    });

    if (payloadKey === lastSavedLayoutPayloadRef.current) return;

    if (saveLayoutTimeoutRef.current) {
      window.clearTimeout(saveLayoutTimeoutRef.current);
    }

    saveLayoutTimeoutRef.current = window.setTimeout(async () => {
      const previousLayouts = liveLayouts;
      const nextLayouts = {
        layouts: liveLayouts.layouts.map((layout) => (
          layout.id === activeLayoutId
            ? {
              ...layout,
              cols: WORKSPACE_GRID_COLS,
              rows: WORKSPACE_GRID_ROWS,
              cellAspect: layoutCellAspect,
              tiles,
              slots,
              cameras: tiles.map((tile) => tile.camera),
            }
            : layout
        )),
      };

      try {
        lastSavedLayoutPayloadRef.current = payloadKey;
        queryClient.setQueryData(['live-layouts'], nextLayouts);
        const saved = await fetchJSON('/api/live-layouts', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: JSON.stringify(nextLayouts),
          timeout: 10000,
          retries: 1,
          retryDelay: 1000,
        });
        const normalized = normalizeLiveLayouts(saved);
        queryClient.setQueryData(['live-layouts'], normalized);
      } catch (error) {
        queryClient.setQueryData(['live-layouts'], previousLayouts);
        lastSavedLayoutPayloadRef.current = '';
        showStatusMessage(error.message || 'Failed to save layout', 'error', 8000);
      } finally {
        saveLayoutTimeoutRef.current = null;
      }
    }, 450);
  }, [activeLayout, activeLayoutId, hydratedLayoutId, layoutCellAspect, liveLayouts, workspaceStarted, workspaceTiles]);

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
      exitSingleCameraView(layoutId);
      if (layoutId) {
        setHydratedLayoutId((previousHydratedLayoutId) => (
          previousHydratedLayoutId === layoutId ? previousHydratedLayoutId : ''
        ));
      }
      setLayoutPresetMenuOpen(false);
      setWorkspaceMenuOpen(false);
    };

    const handleShowLayoutCamera = (event) => {
      const layoutId = String(event.detail?.layoutId || '').trim();
      const cameraId = String(event.detail?.cameraId || event.detail?.cameraName || '').trim();
      enterSingleCameraView(layoutId, cameraId);
    };

    window.addEventListener('oneberry:show-live-layout', handleShowLayout);
    window.addEventListener('oneberry:show-live-layout-camera', handleShowLayoutCamera);
    return () => {
      window.removeEventListener('oneberry:show-live-layout', handleShowLayout);
      window.removeEventListener('oneberry:show-live-layout-camera', handleShowLayoutCamera);
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
      cols: WORKSPACE_GRID_COLS,
      rows: WORKSPACE_GRID_ROWS,
      cellAspect: layoutCellAspect,
      tiles,
      slots,
      cameras: tiles.map((tile) => tile.camera),
    };
    const previousLayouts = liveLayouts;
    const saved = await saveLiveLayouts({
      layouts: [...liveLayouts.layouts, nextLayout],
    }, previousLayouts);
    const savedLayout = saved.layouts.find((layout) => layout.id === nextLayout.id) || nextLayout;
    setActiveLayoutId(savedLayout.id);
    setHydratedLayoutId(savedLayout.id);
    setLayoutEditMode(false);
    lastSavedLayoutPayloadRef.current = JSON.stringify({
      id: savedLayout.id,
      cols: WORKSPACE_GRID_COLS,
      rows: WORKSPACE_GRID_ROWS,
      cellAspect: layoutCellAspect,
      tiles,
      slots,
    });
    return savedLayout;
  }, [layoutCellAspect, liveLayouts, saveLiveLayouts, workspaceTiles]);

  const saveCurrentWorkspaceLayout = useCallback(async () => {
    if (!activeLayoutId || !activeLayout) {
      const name = window.prompt('Layout name');
      if (name) await saveCurrentWorkspaceAsLayout(name);
      return;
    }

    const tiles = serializeWorkspaceTilesForSave(workspaceTiles);
    const slots = serializeWorkspaceSlotsForSave(workspaceTiles);
    const previousLayouts = liveLayouts;
    const nextLayouts = {
      layouts: liveLayouts.layouts.map((layout) => (
        layout.id === activeLayoutId
          ? {
            ...layout,
            cols: WORKSPACE_GRID_COLS,
            rows: WORKSPACE_GRID_ROWS,
            cellAspect: layoutCellAspect,
            tiles,
            slots,
            cameras: tiles.map((tile) => tile.camera),
          }
          : layout
      )),
    };
    await saveLiveLayouts(nextLayouts, previousLayouts);
    lastSavedLayoutPayloadRef.current = JSON.stringify({
      id: activeLayoutId,
      cols: WORKSPACE_GRID_COLS,
      rows: WORKSPACE_GRID_ROWS,
      cellAspect: layoutCellAspect,
      tiles,
      slots,
    });
    showStatusMessage('Layout saved');
    setLayoutEditMode(false);
  }, [activeLayout, activeLayoutId, layoutCellAspect, liveLayouts, saveCurrentWorkspaceAsLayout, saveLiveLayouts, workspaceTiles]);

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
    setActiveLayoutId('');
    setLayoutEditMode(false);
    setHydratedLayoutId('');
    lastSavedLayoutPayloadRef.current = '';
    setWorkspaceTiles([]);
    setWorkspaceStarted(true);
    setLayoutEditMode(true);
    setWorkspaceAutoGrid(true);
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
      if (layoutEditMode) await saveCurrentWorkspaceLayout();
      setLayoutEditMode(false);
    }
    await updateActiveLayout({ locked }, locked ? 'Layout locked. Unlock it to make changes.' : 'Layout unlocked');
  }, [activeLayout, layoutEditMode, saveCurrentWorkspaceLayout, updateActiveLayout]);

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
    setLayoutEditMode(!activeLayoutId);
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
      ? getTileArrangement(workspaceTiles)
      : { cols, rows };

  // Black space around the grid so every cell keeps the cell shape
  useEffect(() => {
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
  }, [cellArrangement.cols, cellArrangement.rows, effectiveCellAspect, isMobileViewport, isWorkspaceMode, singleCameraMode, streamsToShow.length]);

  // The unsaved workspace remembers its cell shape in this browser
  useEffect(() => {
    if (activeLayoutId) return;
    try {
      localStorage.setItem(LIVE_CELL_ASPECT_STORAGE_KEY, layoutCellAspect);
    } catch {}
  }, [activeLayoutId, layoutCellAspect]);
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
            <div className="live-workspace-title">
              <span>{activeLayout?.name || 'Unsaved workspace'}</span>
              <small>
                {singleCameraMode && singleCameraStream ? `${singleCameraStream.name} · ` : ''}
                {visibleWorkspaceTileCount} camera tile{visibleWorkspaceTileCount === 1 ? '' : 's'}
                {workspaceEmptySlotCount > 0 ? ` · ${workspaceEmptySlotCount} empty` : ''}
                {singleCameraMode ? ' · Single camera' : (activeLayoutId ? ` · ${layoutEditMode ? 'Editing' : 'Locked'}` : '')}
              </small>
            </div>
            <div className="live-workspace-header-actions">
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
                    title={workspaceLocked ? 'Click Edit Layout from the menu before changing this saved layout' : 'Choose an empty grid layout'}
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
                            onClick={() => { setLayoutCellAspect(option); setWorkspaceMenuOpen(false); }}
                          >
                            {option === 'auto' ? 'Auto' : option}
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
                      layoutEditMode && !isLockedLayout ? (
                        <button type="button" role="menuitem" onClick={() => { setWorkspaceMenuOpen(false); setLayoutEditMode(false); }}>Done Editing</button>
                      ) : (
                        <button
                          type="button"
                          role="menuitem"
                          disabled={isLockedLayout}
                          title={isLockedLayout ? 'Unlock the layout to edit it' : undefined}
                          onClick={() => { setWorkspaceMenuOpen(false); setLayoutEditMode(true); }}
                        >
                          Edit Layout
                        </button>
                      )
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
        <div
          id="video-grid"
          ref={workspaceGridRef}
          className={`video-container ${isWorkspaceMode ? 'is-workspace-grid' : gridHasEmptySlots ? 'is-partial-grid' : 'is-filled-grid'} ${visibleWorkspaceTileCount === 1 ? 'is-single-camera' : ''} ${singleCameraMode ? 'is-single-camera-view' : ''} ${isMobileViewport && isWorkspaceMode && !singleCameraMode ? 'is-mobile-workspace-stack' : ''} ${movingTileId ? 'is-moving-tile' : ''}`}
          style={{
            '--grid-cols': workspaceGridCols,
            '--grid-rows': workspaceGridRows,
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
                    className={`live-workspace-tile ${removingTileIds.has(tileInstanceId) ? 'is-removing' : ''} ${isSingleCameraActiveTile ? 'is-single-camera-active' : ''} ${isSingleCameraInactiveTile ? 'is-single-camera-inactive' : ''} ${tileInstanceId && movingTileId === tileInstanceId ? 'is-moving' : ''} ${tileInstanceId && tileDropTargetId === tileInstanceId ? 'is-drop-target' : ''}`}
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
                      <>
                        {['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'].map((handle) => (
                          <span
                            key={handle}
                            className={`live-workspace-resize-handle is-${handle}`}
                            aria-hidden="true"
                            onPointerDown={(event) => startWorkspacePointer(event, workspaceTile, 'resize', handle)}
                          />
                        ))}
                      </>
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
                );
              })}
            </>
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
