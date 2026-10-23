/**
 * Live View layout tabs (Nx Witness style): every open layout is a tab, a new
 * tab starts as an empty "New Layout", and changes stay a draft (shown on the
 * tab) until the user saves. Tabs and drafts are kept in this browser so they
 * survive leaving the Live page or reloading it.
 *
 * Tab: { key, layoutId, title, draft }
 *   layoutId  saved layout shown in the tab ('' for a new, unsaved layout)
 *   title     name of an unsaved layout ("New Layout", "New Layout 2", ...)
 *   draft     unsaved changes: { tiles, cellAspect, cellSpacing, autoGrid, baseline },
 *             or null when the tab shows the saved layout as it is
 */

export const LIVE_TABS_STORAGE_KEY = 'lightnvr-live-tabs-v1';
export const NEW_LAYOUT_TITLE = 'New Layout';

export function createTabKey() {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/** "New Layout", then "New Layout 2", "New Layout 3"... (first free number). */
export function nextNewLayoutTitle(tabs) {
  const used = new Set((tabs || []).filter((tab) => !tab.layoutId).map((tab) => tab.title));
  if (!used.has(NEW_LAYOUT_TITLE)) return NEW_LAYOUT_TITLE;
  for (let number = 2; ; number++) {
    const title = `${NEW_LAYOUT_TITLE} ${number}`;
    if (!used.has(title)) return title;
  }
}

export function createLayoutTab(layoutId = '', tabs = []) {
  return {
    key: createTabKey(),
    layoutId: layoutId || '',
    title: layoutId ? '' : nextNewLayoutTitle(tabs),
    draft: null,
  };
}

/** Tab to show after closing one: the tab to its right, else to its left. */
export function tabKeyAfterClose(tabs, closingKey, activeKey) {
  if (closingKey !== activeKey) return activeKey;
  const index = tabs.findIndex((tab) => tab.key === closingKey);
  const remaining = tabs.filter((tab) => tab.key !== closingKey);
  if (remaining.length === 0) return '';
  return remaining[Math.min(index, remaining.length - 1)].key;
}

function isValidTab(tab) {
  return tab && typeof tab.key === 'string' && tab.key &&
    typeof (tab.layoutId ?? '') === 'string' &&
    (tab.draft === null || tab.draft === undefined || (typeof tab.draft === 'object' && Array.isArray(tab.draft.tiles)));
}

/**
 * Saved tabs for this user, or null when there are none (or they belong to
 * another user who used this browser).
 */
export function loadLayoutTabs(username, storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(LIVE_TABS_STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || (data.user || '') !== (username || '')) return null;
    const tabs = (Array.isArray(data.tabs) ? data.tabs : []).filter(isValidTab).map((tab) => ({
      key: tab.key,
      layoutId: tab.layoutId || '',
      title: tab.layoutId ? '' : (tab.title || NEW_LAYOUT_TITLE),
      draft: tab.draft || null,
    }));
    if (tabs.length === 0) return null;
    const activeKey = tabs.some((tab) => tab.key === data.activeKey) ? data.activeKey : tabs[0].key;
    return { tabs, activeKey };
  } catch {
    return null;
  }
}

export function saveLayoutTabs(username, tabs, activeKey, storage = globalThis.localStorage) {
  try {
    storage?.setItem(LIVE_TABS_STORAGE_KEY, JSON.stringify({ user: username || '', tabs, activeKey }));
  } catch {
    // Storage full or blocked: tabs still work for this visit
  }
}

/**
 * Drop tabs of layouts that no longer exist (deleted, or no longer shared with
 * this user). An unsaved draft of a deleted layout is kept as a new layout.
 */
export function reconcileTabsWithLayouts(tabs, layoutIds) {
  const known = new Set(layoutIds || []);
  const next = [];
  (tabs || []).forEach((tab) => {
    if (!tab.layoutId || known.has(tab.layoutId)) {
      next.push(tab);
    } else if (tab.draft && tab.draft.tiles.length > 0) {
      next.push({ ...tab, layoutId: '', title: nextNewLayoutTitle(next), draft: { ...tab.draft, baseline: '' } });
    }
  });
  return next;
}
