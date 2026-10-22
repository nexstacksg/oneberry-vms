/**
 * Nx Witness style Live View scene: tiles sit on a grid of equal cells (x, y,
 * w, h in whole cells). The scene is as large as its tiles need and grows when
 * tiles are added or enlarged; Live View fits it to the screen.
 */

export const SCENE_MAX_SIDE = 16;

/**
 * Whole cells (w x h) whose shape is closest to a camera picture's shape.
 * @param {number} cameraAspect picture width / height
 * @param {number} cellAspect   cell width / height
 * @returns {{w:number, h:number}}
 */
export function spanForAspect(cameraAspect, cellAspect) {
  if (!(cameraAspect > 0) || !(cellAspect > 0)) return { w: 1, h: 1 };
  let best = { w: 1, h: 1 };
  let bestScore = Number.POSITIVE_INFINITY;
  for (let w = 1; w <= 3; w++) {
    for (let h = 1; h <= 3; h++) {
      const spanAspect = (w * cellAspect) / h;
      // Shape error, plus a little per extra cell so the smallest fitting span wins
      const score = Math.abs(Math.log(spanAspect / cameraAspect)) + 0.04 * (w * h - 1);
      if (score < bestScore - 1e-9) {
        best = { w, h };
        bestScore = score;
      }
    }
  }
  return best;
}

/** Columns and rows the tiles cover (at least 1 x 1). */
export function sceneBounds(tiles) {
  let cols = 1;
  let rows = 1;
  (tiles || []).forEach((tile) => {
    cols = Math.max(cols, (Number(tile.x) || 0) + (Number(tile.w) || 1));
    rows = Math.max(rows, (Number(tile.y) || 0) + (Number(tile.h) || 1));
  });
  return { cols, rows };
}

/** Move all tiles so the scene starts at the top-left cell. */
export function normalizeSceneOrigin(tiles) {
  if (!tiles || tiles.length === 0) return tiles;
  const minX = Math.min(...tiles.map((tile) => Number(tile.x) || 0));
  const minY = Math.min(...tiles.map((tile) => Number(tile.y) || 0));
  if (minX === 0 && minY === 0) return tiles;
  return tiles.map((tile) => ({ ...tile, x: (Number(tile.x) || 0) - minX, y: (Number(tile.y) || 0) - minY }));
}

export function isAreaFree(tiles, x, y, w, h, ignoreId = '') {
  if (x < 0 || y < 0) return false;
  return !(tiles || []).some((tile) => (
    tile.instanceId !== ignoreId &&
    x < tile.x + tile.w && x + w > tile.x &&
    y < tile.y + tile.h && y + h > tile.y
  ));
}

const sceneScore = (cols, rows, cellAspect, viewportAspect) => (
  Math.abs(Math.log(((cols * cellAspect) / rows) / viewportAspect))
);

/**
 * Where to put a new w x h tile: a free spot inside the scene (nearest the
 * preferred cell if given), otherwise just outside it on the side that keeps
 * the scene's shape closest to the screen's.
 * @returns {{x:number, y:number}}
 */
export function findSceneSpot(tiles, w, h, { preferred = null, cellAspect = 16 / 9, viewportAspect = 16 / 9 } = {}) {
  const list = tiles || [];
  if (list.length === 0) return { x: 0, y: 0 };
  const { cols, rows } = sceneBounds(list);

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let y = 0; y + h <= rows; y++) {
    for (let x = 0; x + w <= cols; x++) {
      if (!isAreaFree(list, x, y, w, h)) continue;
      const distance = preferred
        ? Math.abs(x - preferred.x) + Math.abs(y - preferred.y)
        : y * 1000 + x;
      if (distance < bestDistance) {
        best = { x, y };
        bestDistance = distance;
      }
    }
  }
  if (best) return best;

  // Grow the scene: a new column on the right or a new row at the bottom
  const candidates = [];
  for (let y = 0; y + h <= Math.max(rows, h); y++) {
    if (isAreaFree(list, cols, y, w, h)) {
      candidates.push({ x: cols, y, cols: cols + w, rows: Math.max(rows, y + h) });
      break;
    }
  }
  for (let x = 0; x + w <= Math.max(cols, w); x++) {
    if (isAreaFree(list, x, rows, w, h)) {
      candidates.push({ x, y: rows, cols: Math.max(cols, x + w), rows: rows + h });
      break;
    }
  }
  candidates.sort((a, b) => (
    sceneScore(a.cols, a.rows, cellAspect, viewportAspect) - sceneScore(b.cols, b.rows, cellAspect, viewportAspect)
  ));
  return candidates[0] ? { x: candidates[0].x, y: candidates[0].y } : { x: cols, y: 0 };
}

/**
 * Rearrange tiles (keeping their sizes and order) into the scene whose shape
 * best matches the screen. Used by the automatic layout.
 */
export function packSceneTiles(tiles, { cellAspect = 16 / 9, viewportAspect = 16 / 9 } = {}) {
  const list = tiles || [];
  if (list.length === 0) return list;
  const widest = Math.max(...list.map((tile) => tile.w || 1));
  const totalCells = list.reduce((sum, tile) => sum + (tile.w || 1) * (tile.h || 1), 0);
  const maxCols = Math.min(SCENE_MAX_SIDE, Math.max(widest, totalCells));

  let best = null;
  for (let cols = widest; cols <= maxCols; cols++) {
    const placed = [];
    list.forEach((tile) => {
      const w = tile.w || 1;
      const h = tile.h || 1;
      for (let y = 0; ; y++) {
        let done = false;
        for (let x = 0; x + w <= cols; x++) {
          if (isAreaFree(placed, x, y, w, h)) {
            placed.push({ ...tile, x, y, w, h });
            done = true;
            break;
          }
        }
        if (done) break;
      }
    });
    const bounds = sceneBounds(placed);
    const empty = bounds.cols * bounds.rows - totalCells;
    const score = sceneScore(bounds.cols, bounds.rows, cellAspect, viewportAspect) + empty * 0.15;
    if (!best || score < best.score - 1e-9) best = { score, placed };
  }
  return best.placed;
}

/**
 * Columns for a grid that fills in reading order as cameras are added:
 * 1, 2, 2x2, 3x2, 3x3, 4x3, 4x4 ... (by cells used, so big tiles count more).
 */
export function sequenceColumns(cellCount) {
  return Math.max(1, Math.min(SCENE_MAX_SIDE, Math.ceil(Math.sqrt(Math.max(1, cellCount)))));
}

/** First free w x h spot in reading order (row by row, left to right) within `cols` columns. */
function firstFreeInReadingOrder(tiles, w, h, cols) {
  for (let y = 0; ; y++) {
    for (let x = 0; x + w <= Math.max(cols, w); x++) {
      if (isAreaFree(tiles, x, y, w, h)) return { x, y };
    }
  }
}

/**
 * Automatic layout: tiles keep the order they were added and fill the grid
 * row by row; the grid widens step by step as more cameras come in.
 */
export function packSequentialTiles(tiles) {
  const list = tiles || [];
  if (list.length === 0) return list;
  const widest = Math.max(...list.map((tile) => tile.w || 1));
  const totalCells = list.reduce((sum, tile) => sum + (tile.w || 1) * (tile.h || 1), 0);
  const cols = Math.max(widest, sequenceColumns(totalCells));
  const placed = [];
  list.forEach((tile) => {
    const w = tile.w || 1;
    const h = tile.h || 1;
    const spot = firstFreeInReadingOrder(placed, w, h, cols);
    placed.push({ ...tile, x: spot.x, y: spot.y, w, h });
  });
  return placed;
}

/**
 * Where a new camera goes in an arranged layout, without moving any camera:
 * the first free cell in reading order; when the scene is full, a new column
 * while the scene is narrower than the sequence grid, otherwise a new row.
 * @returns {{x:number, y:number}}
 */
export function findSequentialSpot(tiles, w, h) {
  const list = tiles || [];
  if (list.length === 0) return { x: 0, y: 0 };
  const { cols, rows } = sceneBounds(list);
  for (let y = 0; y + h <= rows; y++) {
    for (let x = 0; x + w <= cols; x++) {
      if (isAreaFree(list, x, y, w, h)) return { x, y };
    }
  }
  const usedCells = list.reduce((sum, tile) => sum + (tile.w || 1) * (tile.h || 1), 0);
  if (cols < sequenceColumns(usedCells + w * h) && cols + w <= SCENE_MAX_SIDE) {
    // New column on the right, from the top
    for (let y = 0; ; y++) {
      if (isAreaFree(list, cols, y, w, h)) return { x: cols, y };
    }
  }
  // New row at the bottom, from the left
  return firstFreeInReadingOrder(list, w, h, Math.max(cols, w));
}

/**
 * Layouts saved before the scene used whole cells (48-unit grid): scale them
 * so their smallest tile becomes one cell.
 * @param {Object[]} areas tiles and slots with x, y, w, h
 */
export function convertLegacyAreasToCells(areas) {
  const list = areas || [];
  if (list.length === 0) return list;
  const unitW = Math.max(1, Math.min(...list.map((area) => Number(area.w) || 1)));
  const unitH = Math.max(1, Math.min(...list.map((area) => Number(area.h) || 1)));
  const converted = [];
  list.forEach((area) => {
    let x = Math.round((Number(area.x) || 0) / unitW);
    let y = Math.round((Number(area.y) || 0) / unitH);
    const w = Math.max(1, Math.round((Number(area.w) || 1) / unitW));
    const h = Math.max(1, Math.round((Number(area.h) || 1) / unitH));
    if (!isAreaFree(converted, x, y, w, h)) {
      const spot = findSceneSpot(converted, w, h);
      x = spot.x;
      y = spot.y;
    }
    converted.push({ ...area, x, y, w, h });
  });
  return normalizeSceneOrigin(converted);
}

/**
 * Give one tile a new place/size; tiles it now covers move to the nearest
 * free cells (the scene grows if needed) and empty slots it covers go away.
 * This is how a camera is made bigger in Nx Witness: the others make room
 * and, with the scene fitted to the screen, show smaller.
 * @param {Object[]} tiles
 * @param {string} tileId
 * @param {{x:number,y:number,w:number,h:number}} rect
 * @param {Object} [context] { cellAspect, viewportAspect }
 * @returns {Object[]}
 */
export function placeTileWithDisplacement(tiles, tileId, rect, context = {}) {
  const resized = (tiles || []).find((tile) => tile.instanceId === tileId);
  if (!resized) return tiles;
  const placed = { ...resized, ...rect };
  const covers = (tile) => (
    tile.instanceId !== tileId &&
    placed.x < tile.x + tile.w && placed.x + placed.w > tile.x &&
    placed.y < tile.y + tile.h && placed.y + placed.h > tile.y
  );

  const kept = [];
  const displaced = [];
  tiles.forEach((tile) => {
    if (tile.instanceId === tileId) return;
    if (!covers(tile)) {
      kept.push(tile);
    } else if (tile.type !== 'slot') {
      displaced.push(tile);
    }
  });

  let result = [...kept, placed];
  displaced
    .sort((a, b) => (a.y - b.y) || (a.x - b.x))
    .forEach((tile) => {
      const spot = findSceneSpot(result, tile.w, tile.h, { ...context, preferred: { x: tile.x, y: tile.y } });
      result = [...result, { ...tile, x: spot.x, y: spot.y }];
    });

  // Keep the original order of tiles (stable keys and drawing order)
  const byId = new Map(result.map((tile) => [tile.instanceId, tile]));
  return normalizeSceneOrigin(tiles.filter((tile) => byId.has(tile.instanceId)).map((tile) => byId.get(tile.instanceId)));
}

/** True if no camera (empty slots do not count) overlaps the rectangle. */
export function isRectFreeOfCameras(tiles, rect, ignoreId = '') {
  return !(tiles || []).some((tile) => (
    tile.instanceId !== ignoreId && tile.type !== 'slot' &&
    rect.x < tile.x + tile.w && rect.x + rect.w > tile.x &&
    rect.y < tile.y + tile.h && rect.y + rect.h > tile.y
  ));
}

/**
 * Put a tile on free cells (Nx Witness: only free cells are allowed; they show
 * green, occupied ones red). The rectangle may lie outside the current scene,
 * even left of or above it; the scene then grows. Empty slots underneath go away.
 * Returns null when cameras are in the way or the scene would get too large.
 */
export function placeTileOnFreeCells(tiles, tileId, rect) {
  const list = tiles || [];
  const tile = list.find((item) => item.instanceId === tileId);
  if (!tile || !isRectFreeOfCameras(list, rect, tileId)) return null;
  const covers = (item) => (
    rect.x < item.x + item.w && rect.x + rect.w > item.x &&
    rect.y < item.y + item.h && rect.y + rect.h > item.y
  );
  const next = list
    .filter((item) => item.instanceId === tileId || item.type !== 'slot' || !covers(item))
    .map((item) => (item.instanceId === tileId ? { ...item, ...rect } : item));
  const minX = Math.min(...next.map((item) => item.x));
  const minY = Math.min(...next.map((item) => item.y));
  const maxX = Math.max(...next.map((item) => item.x + item.w));
  const maxY = Math.max(...next.map((item) => item.y + item.h));
  if (maxX - minX > SCENE_MAX_SIDE || maxY - minY > SCENE_MAX_SIDE) return null;
  return normalizeSceneOrigin(next);
}

// Space between cameras (Nx Witness "Cell Spacing"), in pixels
export const CELL_SPACING_OPTIONS = ['none', 'small', 'medium', 'large'];
export const CELL_SPACING_PX = { none: 0, small: 4, medium: 8, large: 16 };

/** One step more (+1) or less (-1) spacing, as Ctrl + mouse wheel does. */
export function stepCellSpacing(current, direction) {
  const index = Math.max(0, CELL_SPACING_OPTIONS.indexOf(current));
  const next = Math.max(0, Math.min(CELL_SPACING_OPTIONS.length - 1, index + (direction > 0 ? 1 : -1)));
  return CELL_SPACING_OPTIONS[next];
}
