/**
 * Layout fields beyond tiles that every reader of /api/live-layouts must keep,
 * so saving a layout from one place (e.g. renaming it in the sidebar) does not
 * drop what another place set.
 */

/**
 * @param {Object} layout raw layout from /api/live-layouts
 * @returns {Object} the extra fields, normalized
 */
export function pickLiveLayoutExtras(layout = {}) {
  const extras = {};
  if (Array.isArray(layout.slots)) {
    extras.slots = layout.slots
      .filter((slot) => slot && typeof slot === 'object')
      .map((slot, index) => ({
        id: String(slot.id || `slot-${index + 1}`),
        x: Math.max(0, Math.floor(Number(slot.x) || 0)),
        y: Math.max(0, Math.floor(Number(slot.y) || 0)),
        w: Math.max(1, Math.floor(Number(slot.w) || 1)),
        h: Math.max(1, Math.floor(Number(slot.h) || 1)),
      }));
  }
  if (typeof layout.cellAspect === 'string') extras.cellAspect = layout.cellAspect;
  if (layout.locked === true) extras.locked = true;
  if (Array.isArray(layout.sharedWith)) {
    extras.sharedWith = layout.sharedWith.map(Number).filter((id) => Number.isFinite(id) && id > 0);
  }
  if (layout.background && Number(layout.background.version) > 0) {
    extras.background = {
      version: Number(layout.background.version),
      opacity: Math.min(1, Math.max(0.1, Number(layout.background.opacity) || 0.6)),
    };
  }
  if (layout.sharedWithMe === true) {
    extras.sharedWithMe = true;
    if (layout.ownerName) extras.ownerName = String(layout.ownerName);
  }
  return extras;
}

/** Tile resolution ('high'/'low'); auto is the default and not stored */
export function pickTileQuality(tile = {}) {
  return tile.quality === 'high' || tile.quality === 'low' ? { quality: tile.quality } : {};
}
