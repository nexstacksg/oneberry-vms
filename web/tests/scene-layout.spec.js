import {
  convertLegacyAreasToCells,
  findSceneSpot,
  isAreaFree,
  normalizeSceneOrigin,
  packSceneTiles,
  placeTileWithDisplacement,
  sceneBounds,
  spanForAspect,
} from '../js/utils/scene-layout.js';

const tile = (id, x, y, w = 1, h = 1) => ({ instanceId: id, x, y, w, h });

describe('spanForAspect', () => {
  it('a camera with the cell shape takes one cell', () => {
    expect(spanForAspect(16 / 9, 16 / 9)).toEqual({ w: 1, h: 1 });
  });
  it('a portrait camera in 16:9 cells takes a tall span', () => {
    expect(spanForAspect(9 / 16, 16 / 9)).toEqual({ w: 1, h: 3 });
  });
  it('a 4:3 camera in 16:9 cells stays one cell (closest shape)', () => {
    expect(spanForAspect(4 / 3, 16 / 9)).toEqual({ w: 1, h: 1 });
  });
  it('a panoramic camera takes a wide span', () => {
    expect(spanForAspect(32 / 9, 16 / 9)).toEqual({ w: 2, h: 1 });
  });
  it('unknown shape -> one cell', () => {
    expect(spanForAspect(0, 16 / 9)).toEqual({ w: 1, h: 1 });
  });
});

describe('scene bounds and origin', () => {
  it('covers all tiles', () => {
    expect(sceneBounds([tile('a', 0, 0), tile('b', 2, 1, 1, 2)])).toEqual({ cols: 3, rows: 3 });
    expect(sceneBounds([])).toEqual({ cols: 1, rows: 1 });
  });
  it('moves the scene back to the top-left', () => {
    expect(normalizeSceneOrigin([tile('a', 2, 1), tile('b', 3, 2)]).map((t) => [t.x, t.y])).toEqual([[0, 0], [1, 1]]);
  });
  it('checks free areas', () => {
    const tiles = [tile('a', 0, 0, 2, 2)];
    expect(isAreaFree(tiles, 1, 1, 1, 1)).toBe(false);
    expect(isAreaFree(tiles, 2, 0, 1, 1)).toBe(true);
    expect(isAreaFree(tiles, 1, 1, 1, 1, 'a')).toBe(true);
  });
});

describe('findSceneSpot', () => {
  it('uses a free cell inside the scene first', () => {
    const tiles = [tile('a', 0, 0), tile('b', 1, 0), tile('c', 0, 1)];
    expect(findSceneSpot(tiles, 1, 1)).toEqual({ x: 1, y: 1 });
  });
  it('grows the scene on the side that keeps it closest to the screen shape', () => {
    // 1 cell in a wide screen: add to the right, not below
    expect(findSceneSpot([tile('a', 0, 0)], 1, 1, { cellAspect: 16 / 9, viewportAspect: 16 / 9 })).toEqual({ x: 1, y: 0 });
    // 2 cells side by side: a 2x2 is closer to 16:9 than 3x1
    expect(findSceneSpot([tile('a', 0, 0), tile('b', 1, 0)], 1, 1, { cellAspect: 16 / 9, viewportAspect: 16 / 9 })).toEqual({ x: 0, y: 1 });
  });
  it('prefers the cell nearest the drop point', () => {
    const tiles = [tile('a', 0, 0, 3, 1)];
    // scene is 3x1 and full: grows; with room after growing, drop point steers
    expect(findSceneSpot([...tiles, tile('b', 0, 1)], 1, 1, { preferred: { x: 2, y: 1 } })).toEqual({ x: 2, y: 1 });
  });
});

describe('packSceneTiles', () => {
  it('4 one-cell cameras on a 16:9 screen -> 2x2', () => {
    const packed = packSceneTiles([tile('a', 0, 0), tile('b', 0, 0), tile('c', 0, 0), tile('d', 0, 0)]);
    expect(sceneBounds(packed)).toEqual({ cols: 2, rows: 2 });
  });
  it('keeps each tile size and never overlaps', () => {
    const packed = packSceneTiles([tile('tall', 0, 0, 1, 3), tile('b', 0, 0), tile('c', 0, 0), tile('d', 0, 0)]);
    expect(packed.find((t) => t.instanceId === 'tall')).toMatchObject({ w: 1, h: 3 });
    packed.forEach((t) => expect(isAreaFree(packed, t.x, t.y, t.w, t.h, t.instanceId)).toBe(true));
  });
});

describe('convertLegacyAreasToCells', () => {
  it('turns an old 48x48 2x2 layout into a 2x2 scene', () => {
    const old = [tile('a', 0, 0, 24, 24), tile('b', 24, 0, 24, 24), tile('c', 0, 24, 24, 24), tile('d', 24, 24, 24, 24)];
    expect(convertLegacyAreasToCells(old).map((t) => [t.x, t.y, t.w, t.h])).toEqual([[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]]);
  });
  it('keeps a big tile big (1 large + small ones)', () => {
    const old = [tile('big', 0, 0, 32, 32), tile('s1', 32, 0, 16, 16), tile('s2', 32, 16, 16, 16)];
    const converted = convertLegacyAreasToCells(old);
    expect(converted[0]).toMatchObject({ w: 2, h: 2 });
    expect(converted.slice(1).every((t) => t.w === 1 && t.h === 1)).toBe(true);
  });
});

describe('placeTileWithDisplacement (make a camera bigger, others make room)', () => {
  const ctx = { cellAspect: 16 / 9, viewportAspect: 16 / 9 };
  it('2x2 full scene: growing one camera to 2x2 moves the other three out, scene grows', () => {
    const tiles = [tile('a', 0, 0), tile('b', 1, 0), tile('c', 0, 1), tile('d', 1, 1)];
    const next = placeTileWithDisplacement(tiles, 'a', { x: 0, y: 0, w: 2, h: 2 }, ctx);
    expect(next.find((t) => t.instanceId === 'a')).toMatchObject({ x: 0, y: 0, w: 2, h: 2 });
    expect(next).toHaveLength(4);
    next.forEach((t) => expect(isAreaFree(next, t.x, t.y, t.w, t.h, t.instanceId)).toBe(true));
    const bounds = sceneBounds(next);
    expect(bounds.cols * bounds.rows).toBeGreaterThan(4);
  });
  it('empty slots under the grown camera are removed, cameras are kept', () => {
    const tiles = [tile('a', 0, 0), { ...tile('s', 1, 0), type: 'slot' }, tile('b', 0, 1)];
    const next = placeTileWithDisplacement(tiles, 'a', { x: 0, y: 0, w: 2, h: 1 }, ctx);
    expect(next.map((t) => t.instanceId).sort()).toEqual(['a', 'b']);
  });
  it('tiles not covered stay where they are', () => {
    const tiles = [tile('a', 0, 0), tile('b', 3, 0), tile('c', 1, 0)];
    const next = placeTileWithDisplacement(tiles, 'a', { x: 0, y: 0, w: 1, h: 2 }, ctx);
    expect(next.find((t) => t.instanceId === 'b')).toMatchObject({ x: 3, y: 0 });
    expect(next.find((t) => t.instanceId === 'c')).toMatchObject({ x: 1, y: 0 });
  });
});
