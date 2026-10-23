import {
  LIVE_TABS_STORAGE_KEY,
  createLayoutTab,
  loadLayoutTabs,
  nextNewLayoutTitle,
  reconcileTabsWithLayouts,
  saveLayoutTabs,
  tabKeyAfterClose,
} from '../js/utils/live-layout-tabs.js';

const memoryStorage = () => {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
  };
};

describe('layout tabs', () => {
  it('names new layouts New Layout, New Layout 2, ...', () => {
    expect(nextNewLayoutTitle([])).toBe('New Layout');
    const first = createLayoutTab('', []);
    const second = createLayoutTab('', [first]);
    expect(second.title).toBe('New Layout 2');
    // a saved layout tab has no title of its own
    expect(createLayoutTab('abc', [first]).title).toBe('');
    // the first free number is reused
    expect(nextNewLayoutTitle([{ layoutId: '', title: 'New Layout 2' }])).toBe('New Layout');
  });

  it('after closing the active tab, the one to its right is shown, else the left one', () => {
    const tabs = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
    expect(tabKeyAfterClose(tabs, 'b', 'b')).toBe('c');
    expect(tabKeyAfterClose(tabs, 'c', 'c')).toBe('b');
    expect(tabKeyAfterClose(tabs, 'a', 'c')).toBe('c');
    expect(tabKeyAfterClose([{ key: 'a' }], 'a', 'a')).toBe('');
  });

  it('tabs and drafts are kept per user in this browser', () => {
    const storage = memoryStorage();
    const tabs = [
      { key: 'a', layoutId: 'l1', title: '', draft: null },
      { key: 'b', layoutId: '', title: 'New Layout', draft: { tiles: [{ instanceId: 't1' }], cellAspect: 'auto', cellSpacing: 'medium', autoGrid: true, baseline: '' } },
    ];
    saveLayoutTabs('alice', tabs, 'b', storage);
    expect(loadLayoutTabs('alice', storage)).toEqual({ tabs, activeKey: 'b' });
    expect(loadLayoutTabs('bob', storage)).toBeNull();
  });

  it('ignores broken saved data', () => {
    const storage = memoryStorage();
    storage.setItem(LIVE_TABS_STORAGE_KEY, '{not json');
    expect(loadLayoutTabs('alice', storage)).toBeNull();
    storage.setItem(LIVE_TABS_STORAGE_KEY, JSON.stringify({ user: 'alice', tabs: [{ nokey: 1 }], activeKey: 'x' }));
    expect(loadLayoutTabs('alice', storage)).toBeNull();
  });

  it('drops tabs of deleted layouts, but keeps an unsaved draft as a new layout', () => {
    const tabs = [
      { key: 'a', layoutId: 'kept', title: '', draft: null },
      { key: 'b', layoutId: 'gone', title: '', draft: null },
      { key: 'c', layoutId: 'gone2', title: '', draft: { tiles: [{ instanceId: 't' }], baseline: 'x' } },
    ];
    const next = reconcileTabsWithLayouts(tabs, ['kept']);
    expect(next.map((tab) => [tab.key, tab.layoutId, tab.title])).toEqual([['a', 'kept', ''], ['c', '', 'New Layout']]);
    expect(next[1].draft.baseline).toBe('');
  });
});
