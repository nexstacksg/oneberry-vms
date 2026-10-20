import { normalizeItemQuality, resolveItemQuality } from '../js/components/preact/useItemQuality.js';

const base = { itemQuality: 'auto', hasLowQuality: true, isOnlyItem: false, isFullscreen: false, tileHeight: 0 };

describe('resolveItemQuality (Nx adaptive scaling)', () => {
  it('uses the main stream for a camera without a sub stream, whatever the setting', () => {
    expect(resolveItemQuality({ ...base, hasLowQuality: false, itemQuality: 'low', tileHeight: 50 })).toBe('high');
  });
  it('respects a fixed High or Low setting', () => {
    expect(resolveItemQuality({ ...base, itemQuality: 'high', tileHeight: 50 })).toBe('high');
    expect(resolveItemQuality({ ...base, itemQuality: 'low', tileHeight: 900, isFullscreen: true })).toBe('low');
  });
  it('auto: high for the only item and for fullscreen', () => {
    expect(resolveItemQuality({ ...base, isOnlyItem: true, tileHeight: 100 })).toBe('high');
    expect(resolveItemQuality({ ...base, isFullscreen: true, tileHeight: 100 })).toBe('high');
  });
  it('auto: high above about 172px tall, low below', () => {
    expect(resolveItemQuality({ ...base, tileHeight: 360 })).toBe('high');
    expect(resolveItemQuality({ ...base, tileHeight: 140 })).toBe('low');
  });
  it('auto: does not flip back and forth right at the threshold', () => {
    expect(resolveItemQuality({ ...base, tileHeight: 175, previous: 'low' })).toBe('low');
    expect(resolveItemQuality({ ...base, tileHeight: 175, previous: 'high' })).toBe('high');
    expect(resolveItemQuality({ ...base, tileHeight: 185, previous: 'low' })).toBe('high');
    expect(resolveItemQuality({ ...base, tileHeight: 160, previous: 'high' })).toBe('low');
  });
  it('auto: before the tile is measured, keeps what it had (low at first)', () => {
    expect(resolveItemQuality({ ...base, tileHeight: 0 })).toBe('low');
    expect(resolveItemQuality({ ...base, tileHeight: 0, previous: 'high' })).toBe('high');
  });
  it('treats unknown settings as auto', () => {
    expect(normalizeItemQuality('medium')).toBe('auto');
    expect(normalizeItemQuality(undefined)).toBe('auto');
  });
});
