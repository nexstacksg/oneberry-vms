import {
  computeCellPadding,
  findTileAtPoint,
  getForcedAspectVideoStyle,
  getTileArrangement,
  parseAspectRatio,
  swapTilePlaces,
} from '../js/utils/aspect-ratio-utils.js';

describe('parseAspectRatio', () => {
  it('parses W:H', () => {
    expect(parseAspectRatio('16:9')).toBeCloseTo(16 / 9);
    expect(parseAspectRatio('9:16')).toBeCloseTo(9 / 16);
    expect(parseAspectRatio('1:1')).toBe(1);
  });
  it('returns null for auto and junk', () => {
    expect(parseAspectRatio('auto')).toBeNull();
    expect(parseAspectRatio('')).toBeNull();
    expect(parseAspectRatio('0:9')).toBeNull();
    expect(parseAspectRatio('16/9')).toBeNull();
  });
});

describe('getForcedAspectVideoStyle', () => {
  it('fits a box of the forced shape and stretches the picture to it', () => {
    const style = getForcedAspectVideoStyle('4:3');
    expect(style.objectFit).toBe('fill');
    expect(style.width).toBe('min(100cqw, calc(100cqh * 4 / 3))');
    expect(style.height).toBe('min(100cqh, calc(100cqw * 3 / 4))');
  });
  it('changes nothing for auto', () => {
    expect(getForcedAspectVideoStyle('auto')).toEqual({});
    expect(getForcedAspectVideoStyle(undefined)).toEqual({});
  });
});

describe('getTileArrangement', () => {
  it('counts distinct columns and rows', () => {
    const grid2x2 = [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 0, y: 13 }, { x: 24, y: 13 }];
    expect(getTileArrangement(grid2x2)).toEqual({ cols: 2, rows: 2 });
    expect(getTileArrangement([{ x: 0, y: 0 }])).toEqual({ cols: 1, rows: 1 });
    expect(getTileArrangement([])).toEqual({ cols: 1, rows: 1 });
  });
});

describe('computeCellPadding', () => {
  it('adds side bars when the area is wider than the cells need', () => {
    // one 16:9 cell in a 2000x900 area -> 1600x900, 200px each side
    const pad = computeCellPadding({ width: 2000, height: 900, cols: 1, rows: 1, aspect: 16 / 9 });
    expect(pad.x).toBeCloseTo(200);
    expect(pad.y).toBeCloseTo(0);
  });
  it('adds side bars for portrait cells side by side', () => {
    // two 9:16 boxes in 1000x800, 10px apart: height-limited (790 tall each)
    const pad = computeCellPadding({ width: 1000, height: 800, cols: 2, rows: 1, gap: 10, aspect: 9 / 16 });
    const used = 2 * (790 * (9 / 16) + 10);
    expect(pad.y).toBeCloseTo(0);
    expect(pad.x).toBeCloseTo((1000 - used) / 2);
  });
  it('accounts for the gap so every box keeps the shape', () => {
    const { x, y } = computeCellPadding({ width: 1600, height: 1000, cols: 2, rows: 2, gap: 8, aspect: 16 / 9 });
    const boxWidth = (1600 - 2 * x) / 2 - 8;
    const boxHeight = (1000 - 2 * y) / 2 - 8;
    expect(boxWidth / boxHeight).toBeCloseTo(16 / 9);
  });
  it('does nothing without a size', () => {
    expect(computeCellPadding({ width: 0, height: 500, cols: 1, rows: 1, aspect: 1 })).toEqual({ x: 0, y: 0 });
  });
});

describe('swapTilePlaces / findTileAtPoint', () => {
  const tiles = [
    { instanceId: 'a', x: 0, y: 0, w: 32, h: 18 },
    { instanceId: 'b', x: 32, y: 0, w: 16, h: 9 },
    { instanceId: 'c', x: 32, y: 9, w: 16, h: 9 },
  ];
  it('swaps position and size of two tiles of different sizes', () => {
    const next = swapTilePlaces(tiles, 'a', 'b');
    expect(next[0]).toMatchObject({ instanceId: 'a', x: 32, y: 0, w: 16, h: 9 });
    expect(next[1]).toMatchObject({ instanceId: 'b', x: 0, y: 0, w: 32, h: 18 });
    expect(next[2]).toBe(tiles[2]);
  });
  it('leaves tiles alone for unknown ids', () => {
    expect(swapTilePlaces(tiles, 'a', 'zz')).toBe(tiles);
  });
  it('finds the tile under a point, ignoring the dragged one', () => {
    expect(findTileAtPoint(tiles, { x: 40, y: 12 })?.instanceId).toBe('c');
    expect(findTileAtPoint(tiles, { x: 5, y: 5 }, 'a')).toBeNull();
  });
});
