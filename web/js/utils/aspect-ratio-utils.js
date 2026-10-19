/**
 * Aspect ratio helpers for Live View cells and camera pictures (Nx Witness
 * style: layout cells have a shape, and a camera's picture shape can be forced).
 */

export const CELL_ASPECT_OPTIONS = ['auto', '16:9', '4:3', '1:1', '3:4', '9:16'];
export const CAMERA_ASPECT_OPTIONS = ['auto', '16:9', '4:3', '1:1', '3:4', '9:16'];

/**
 * "16:9" -> 1.777…; anything else (including "auto") -> null
 * @param {string} value
 * @returns {number|null}
 */
export function parseAspectRatio(value) {
  const match = /^(\d{1,3}):(\d{1,3})$/.exec(String(value || '').trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? width / height : null;
}

/**
 * Style for a <video> whose picture must be shown with a forced shape: the
 * largest box of that shape that fits its parent, centred, with the picture
 * stretched to it. The parent must be a size container (container-type: size).
 * Returns {} when the camera's own shape is used.
 * @param {string} aspectRatio e.g. "16:9" or "auto"
 * @returns {Object}
 */
export function getForcedAspectVideoStyle(aspectRatio) {
  const match = /^(\d{1,3}):(\d{1,3})$/.exec(String(aspectRatio || '').trim());
  if (!match || !parseAspectRatio(aspectRatio)) return {};
  const [, width, height] = match;
  return {
    objectFit: 'fill',
    width: `min(100cqw, calc(100cqh * ${width} / ${height}))`,
    height: `min(100cqh, calc(100cqw * ${height} / ${width}))`,
    left: '50%',
    top: '50%',
    inset: 'auto',
    transform: 'translate(-50%, -50%)',
  };
}

/**
 * Columns and rows of a layout, counted in camera cells: the number of
 * distinct left edges and top edges of its tiles.
 * @param {{x:number,y:number}[]} tiles
 * @returns {{cols:number, rows:number}}
 */
export function getTileArrangement(tiles) {
  const list = Array.isArray(tiles) ? tiles : [];
  if (list.length === 0) return { cols: 1, rows: 1 };
  const xs = new Set(list.map((tile) => Number(tile.x) || 0));
  const ys = new Set(list.map((tile) => Number(tile.y) || 0));
  return { cols: Math.max(1, xs.size), rows: Math.max(1, ys.size) };
}

/**
 * Black space to add around a grid so each of its cols x rows cells shows a
 * picture box of the given shape, using as much of the available area as
 * possible. Each cell's box is inset by `gap` (half a gap on every side), so
 * neighbouring boxes are `gap` apart.
 * @param {Object} options
 * @param {number} options.width   available content width (px)
 * @param {number} options.height  available content height (px)
 * @param {number} options.cols
 * @param {number} options.rows
 * @param {number} options.gap     space between neighbouring boxes (px)
 * @param {number} options.aspect  box width / height
 * @returns {{x:number, y:number}} extra padding per side (px)
 */
export function computeCellPadding({ width, height, cols, rows, gap = 0, aspect }) {
  const safeCols = Math.max(1, Number(cols) || 1);
  const safeRows = Math.max(1, Number(rows) || 1);
  if (!(width > 0) || !(height > 0) || !(aspect > 0)) return { x: 0, y: 0 };

  const boxHeight = Math.min(
    ((width / safeCols) - gap) / aspect,
    (height / safeRows) - gap
  );
  if (!(boxHeight > 0)) return { x: 0, y: 0 };

  const usedWidth = safeCols * ((boxHeight * aspect) + gap);
  const usedHeight = safeRows * (boxHeight + gap);
  return {
    x: Math.max(0, (width - usedWidth) / 2),
    y: Math.max(0, (height - usedHeight) / 2),
  };
}

/**
 * Swap the places (position and size) of two tiles; other tiles are unchanged.
 * @param {Object[]} tiles
 * @param {string} firstId
 * @param {string} secondId
 * @returns {Object[]}
 */
export function swapTilePlaces(tiles, firstId, secondId) {
  const first = tiles.find((tile) => tile.instanceId === firstId);
  const second = tiles.find((tile) => tile.instanceId === secondId);
  if (!first || !second || first === second) return tiles;
  const place = (tile) => ({ x: tile.x, y: tile.y, w: tile.w, h: tile.h });
  return tiles.map((tile) => {
    if (tile === first) return { ...tile, ...place(second) };
    if (tile === second) return { ...tile, ...place(first) };
    return tile;
  });
}

/**
 * The tile (other than `ignoreId`) covering a grid point, or null.
 * @param {Object[]} tiles
 * @param {{x:number,y:number}} point
 * @param {string} ignoreId
 */
export function findTileAtPoint(tiles, point, ignoreId = '') {
  if (!point) return null;
  return tiles.find((tile) => (
    tile.instanceId !== ignoreId &&
    point.x >= tile.x && point.x < tile.x + tile.w &&
    point.y >= tile.y && point.y < tile.y + tile.h
  )) || null;
}
