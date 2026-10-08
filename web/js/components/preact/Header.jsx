/**
 * LightNVR Web Interface Header Component
 * Preact component for the site header
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'preact/hooks';
import { Fragment } from 'preact';
import { createPortal, memo } from 'preact/compat';
import {VERSION} from '../../version.js';
import { fetchJSON, queryClient, useQuery } from '../../query-client.js';
import { getSettings } from '../../utils/settings-utils.js';
import { showStatusMessage } from './ToastContainer.jsx';
import { ConfirmDialog } from './UI.jsx';
import { EditUserModal } from './users/EditUserModal.jsx';
import { getAuthHeaders, isDemoMode, validateSession } from '../../utils/auth-utils.js';
import { navigateToAppPage } from '../../utils/navigation-utils.js';
import { getStreamStatusKind } from '../../utils/building-hierarchy.js';
import { preloadLiveSnapshots, startLiveWarmup } from '../../utils/live-warmup.js';
import { useI18n } from '../../i18n.js';
import LanguageSelector from './common/LanguageSelector.jsx';

const navIcons = {
  'nav-live': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M4.75 6.75A2 2 0 0 1 6.75 4.75h10.5a2 2 0 0 1 2 2v10.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2V6.75Zm3 3.25 3.25 2-3.25 2v-4Zm7.25-1.25h2.25m-2.25 3.25h2.25m-2.25 3.25h2.25" />
  ),
  'nav-recordings': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M6.75 5.25h10.5a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2v-9.5a2 2 0 0 1 2-2Zm.75 3.5h9m-9 3.25h5.25m-5.25 3.25h7.25" />
  ),
  'nav-streams': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M5 8.25h14M5 15.75h14M8.25 5v6.5m7.5 1V19M8.25 15.75a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Zm7.5-4.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z" />
  ),
  'nav-settings': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 8.25a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5Zm7.25 3.75a7.7 7.7 0 0 0-.08-1.1l1.45-1.13-1.75-3.03-1.72.7a7.23 7.23 0 0 0-1.9-1.1L15 4.5h-3.5l-.25 1.84c-.68.26-1.32.63-1.9 1.1l-1.72-.7-1.75 3.03 1.45 1.13a7.7 7.7 0 0 0 0 2.2l-1.45 1.13 1.75 3.03 1.72-.7c.58.47 1.22.84 1.9 1.1l.25 1.84H15l.25-1.84c.68-.26 1.32-.63 1.9-1.1l1.72.7 1.75-3.03-1.45-1.13c.05-.36.08-.73.08-1.1Z" />
  ),
  'nav-camera-access': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M7.25 10.25V8.5a4.75 4.75 0 0 1 9.5 0v1.75M6.75 10.25h10.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2Zm5.25 3.25v2.25" />
  ),
  'nav-users': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M9.25 11.25a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm-5 7.5a5 5 0 0 1 10 0m.5-13a2.75 2.75 0 0 1 0 5.5m1.75 7.5a4.25 4.25 0 0 0-2.25-3.75" />
  ),
  'nav-user-groups': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M8.75 10.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Zm-4.5 7.5a4.5 4.5 0 0 1 9 0m3-10.5v5m-2.5-2.5h5m-3.25 8a3.75 3.75 0 0 0-2.25-3.25" />
  ),
  'nav-system': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M5.75 7.25a2 2 0 0 1 2-2h8.5a2 2 0 0 1 2 2v5.5a2 2 0 0 1-2 2h-8.5a2 2 0 0 1-2-2v-5.5Zm3.5 11.5h5.5M12 14.75v4m-3.5-9.5h.01m3.49 0h3.5" />
  ),
  'nav-editProfile': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M12 12.25a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6.25 6.5a6.25 6.25 0 0 1 12.5 0" />
  ),
  'nav-login': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M14.25 5.75h2a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-2m-3.5-3 3.25-3.25-3.25-3.25M14 12H5.75" />
  ),
  'nav-logout': (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M9.75 5.75h-2a2 2 0 0 0-2 2v8.5a2 2 0 0 0 2 2h2m3.5-3 3.25-3.25-3.25-3.25M18.25 12H10" />
  ),
};

const NavIcon = ({ id }) => (
  <span className="sidebar-nav-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {navIcons[id] || navIcons['nav-live']}
    </svg>
  </span>
);

const treeIcons = {
  building: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M5.75 19.25V5.75a1.5 1.5 0 0 1 1.5-1.5h6.5a1.5 1.5 0 0 1 1.5 1.5v13.5m-7-10h.01m3.49 0h.01m-3.51 3.5h.01m3.49 0h.01m-3.51 3.5h.01m8.99 3V10.75h1.5a1.5 1.5 0 0 1 1.5 1.5v7m-10 0v-3h2.5v3m-8.5 0h16" />
  ),
  area: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M5.25 6.75h13.5v10.5H5.25V6.75Zm3 3h2.5v2.5h-2.5v-2.5Zm5 0h2.5v2.5h-2.5v-2.5Zm-5 5h7.5" />
  ),
  camera: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M4.75 8.25a2 2 0 0 1 2-2h7.25a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H6.75a2 2 0 0 1-2-2v-7.5Zm11.25 2.25 3.25-2v7l-3.25-2v-3Z" />
  ),
  folder: (
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" d="M4.25 7.25a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2h7.1a1.5 1.5 0 0 1 1.5 1.5v7.5a1.5 1.5 0 0 1-1.5 1.5H5.75a1.5 1.5 0 0 1-1.5-1.5v-9.5Z" />
  ),
};

const TreeIcon = ({ type }) => (
  <span className={`sidebar-tree-icon sidebar-tree-icon-${type}`} aria-hidden="true">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
      {treeIcons[type] || treeIcons.camera}
    </svg>
  </span>
);

const SidebarCameraRow = memo(({
  cameraHref,
  cameraName,
  statusKind,
  statusLabel,
  isActive,
  isSelected,
  onCameraClick,
  onCameraDoubleClick,
  onCameraDragStart,
  onCameraDragEnd,
  onCameraContextMenu,
  canManage = false,
  menuOpen = false,
  onMenuToggle,
  onEdit,
  onDelete,
  inFolder = false,
  onRemoveFromFolder,
}) => (
  <li className={`sidebar-camera-node ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''} ${menuOpen ? 'is-menu-open' : ''} ${inFolder ? 'is-in-folder' : ''}`} role="presentation">
    <a
      href={cameraHref}
      role="option"
      className={`sidebar-camera-link ${isActive ? 'is-active' : ''} ${isSelected ? 'is-selected' : ''}`}
      title={`${cameraName} - ${statusLabel}. Double-click to open.`}
      aria-current={isActive ? 'page' : undefined}
      aria-selected={isSelected ? 'true' : 'false'}
      draggable={true}
      data-camera-id={cameraName}
      onDragStart={onCameraDragStart}
      onDragEnd={onCameraDragEnd}
      onClick={onCameraClick}
      onDblClick={onCameraDoubleClick}
      onContextMenu={onCameraContextMenu}
    >
      <span className="sidebar-camera-select-indicator" aria-hidden="true"></span>
      <span className={`sidebar-camera-status is-${statusKind}`} aria-hidden="true"></span>
      <TreeIcon type="camera" />
      <span className="sidebar-camera-name">{cameraName}</span>
    </a>
    {canManage && (
      <div className="sidebar-layout-menu-wrap sidebar-camera-menu-wrap" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="sidebar-kebab-button"
          aria-label={`Open ${cameraName} camera menu`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            onMenuToggle(cameraName);
          }}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3.25" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="8" cy="12.75" r="1.2" />
          </svg>
        </button>
        {menuOpen && (
          <div className="sidebar-layout-menu" role="menu">
            <button type="button" role="menuitem" onClick={(event) => onEdit(cameraName, event)}>Edit</button>
            {inFolder && (
              <button type="button" role="menuitem" onClick={() => onRemoveFromFolder(cameraName)}>Remove from folder</button>
            )}
            <button type="button" role="menuitem" className="is-danger" onClick={(event) => onDelete(cameraName, event)}>Delete</button>
          </div>
        )}
      </div>
    )}
  </li>
));

const isKnownValue = (value) => Boolean(value) && value !== 'Unknown' && value !== 'NetworkVideoTransmitter';
const hasKnownModel = (device) => isKnownValue(device?.model);

const getDiscoveredDeviceKey = (device) => (
  String(device?.ip_address || device?.device_service || device?.endpoint || device?.name || '').trim()
);

const mergeDiscoveredDevices = (previousDevices, nextDevices) => {
  const devicesByKey = new Map();

  (Array.isArray(previousDevices) ? previousDevices : []).forEach((device) => {
    const key = getDiscoveredDeviceKey(device);
    if (key) devicesByKey.set(key, device);
  });

  (Array.isArray(nextDevices) ? nextDevices : []).forEach((device) => {
    const key = getDiscoveredDeviceKey(device);
    if (key) devicesByKey.set(key, device);
  });

  return Array.from(devicesByKey.values())
    .sort((a, b) => String(a.ip_address || '').localeCompare(String(b.ip_address || '')));
};

const SIDEBAR_STORAGE_KEY = 'oneberry.dashboardSidebar';
const SIDEBAR_EXPANDED_WIDTH_REM = 17;
const SIDEBAR_COLLAPSED_WIDTH_REM = 5.25;
const SIDEBAR_MIN_WIDTH_REM = 14;
const SIDEBAR_MAX_WIDTH_REM = 22;
const SIDEBAR_COLLAPSE_THRESHOLD_REM = 9;
const CAMERA_LIST_COLLAPSED_STORAGE_KEY = 'oneberry.sidebarCameraListCollapsed';
const DISCOVERY_CAMERA_HANDOFF_KEY = 'oneberry.discoveryCameraHandoff';
const PENDING_BLANK_WORKSPACE_CAMERAS_KEY = 'oneberry.pendingBlankWorkspaceCameras';

const getStoredSidebarState = () => {
  try {
    const stored = localStorage.getItem(SIDEBAR_STORAGE_KEY);
    if (!stored) {
      return { collapsed: false, width: SIDEBAR_EXPANDED_WIDTH_REM };
    }

    const parsed = JSON.parse(stored);
    const storedWidth = Number(parsed.width);
    const width = Number.isFinite(storedWidth)
      ? Math.min(SIDEBAR_MAX_WIDTH_REM, Math.max(SIDEBAR_MIN_WIDTH_REM, storedWidth))
      : SIDEBAR_EXPANDED_WIDTH_REM;

    return {
      collapsed: parsed.collapsed === true,
      width,
    };
  } catch (error) {
    return { collapsed: false, width: SIDEBAR_EXPANDED_WIDTH_REM };
  }
};

const LAYOUT_TREE_STORAGE_KEY = 'oneberry.dashboardLayouts';
const WORKSPACE_GRID_COLS = 48;
const WORKSPACE_GRID_ROWS = 27;
const DEFAULT_WORKSPACE_TILE_W = 24;
const DEFAULT_WORKSPACE_TILE_H = 13;

const getCameraNameList = (cameraNames) => (
  Array.isArray(cameraNames)
    ? cameraNames.map((name) => String(name || '').trim()).filter(Boolean)
    : []
);

const getStoredExpandedTree = (storageKey) => {
  try {
    const stored = localStorage.getItem(storageKey);
    const parsed = stored ? JSON.parse(stored) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch (error) {
    return {};
  }
};

const getStoredCameraListCollapsed = () => {
  try {
    return localStorage.getItem(CAMERA_LIST_COLLAPSED_STORAGE_KEY) === 'true';
  } catch (error) {
    return false;
  }
};

const normalizeLiveLayouts = (data = {}) => ({
  layouts: Array.isArray(data.layouts)
    ? data.layouts
      .filter((layout) => layout && layout.id && layout.name)
      .map((layout) => {
        const legacyCameras = Array.isArray(layout.cameras) ? layout.cameras : [];
        const sourceTiles = Array.isArray(layout.tiles)
          ? layout.tiles
          : legacyCameras.map((camera, index) => ({
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
              x: Number.isFinite(Number(tile?.x)) ? Math.max(0, Math.floor(Number(tile.x))) : index,
              y: Number.isFinite(Number(tile?.y)) ? Math.max(0, Math.floor(Number(tile.y))) : 0,
              w: Number.isFinite(Number(tile?.w)) ? Math.max(1, Math.floor(Number(tile.w))) : 1,
              h: Number.isFinite(Number(tile?.h)) ? Math.max(1, Math.floor(Number(tile.h))) : 1,
            };
          })
          .filter(Boolean);

        return {
          id: String(layout.id),
          userId: layout.userId ?? layout.ownerUserId ?? layout.owner_user_id,
          name: String(layout.name).trim(),
          cols: Number.isFinite(Number(layout.cols)) ? Math.max(1, Math.floor(Number(layout.cols))) : undefined,
          rows: Number.isFinite(Number(layout.rows)) ? Math.max(1, Math.floor(Number(layout.rows))) : undefined,
          tiles,
          cameras: tiles.map((tile) => tile.camera),
        };
      })
      .filter((layout) => layout.name)
    : [],
});

const createLayoutId = () => `layout-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const createCameraFolderId = () => `folder-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const CAMERA_FOLDERS_COLLAPSED_STORAGE_KEY = 'oneberry.sidebarCollapsedCameraFolders';
const getStoredCollapsedFolderIds = () => {
  try {
    const parsed = JSON.parse(localStorage.getItem(CAMERA_FOLDERS_COLLAPSED_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
};
const createLayoutTile = (camera, index = 0) => ({
  id: `tile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  camera,
  x: (index * DEFAULT_WORKSPACE_TILE_W) % WORKSPACE_GRID_COLS,
  y: Math.floor((index * DEFAULT_WORKSPACE_TILE_W) / WORKSPACE_GRID_COLS) * DEFAULT_WORKSPACE_TILE_H,
  w: DEFAULT_WORKSPACE_TILE_W,
  h: DEFAULT_WORKSPACE_TILE_H,
});

const buildResponsiveLayoutTiles = (tiles) => {
  const count = tiles.length;
  if (count === 0) return [];

  const layoutCols = Math.ceil(Math.sqrt(count));
  const layoutRows = Math.ceil(count / layoutCols);
  return tiles.map((tile, index) => {
    const col = index % layoutCols;
    const row = Math.floor(index / layoutCols);
    const x = Math.floor((col * WORKSPACE_GRID_COLS) / layoutCols);
    const y = Math.floor((row * WORKSPACE_GRID_ROWS) / layoutRows);
    const nextX = Math.floor(((col + 1) * WORKSPACE_GRID_COLS) / layoutCols);
    const nextY = Math.floor(((row + 1) * WORKSPACE_GRID_ROWS) / layoutRows);
    return {
      ...tile,
      x,
      y,
      w: Math.max(1, nextX - x),
      h: Math.max(1, nextY - y),
    };
  });
};

const makeLiveHref = (params = {}) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, value);
    }
  });
  const query = search.toString();
  return query ? `index.html?${query}` : 'index.html';
};

const buildProfileFormData = (user = {}) => ({
  username: user.username || '',
  password: '',
  email: user.email || '',
  role: user.role_id ?? 1,
  is_active: user.is_active ?? true,
  password_change_locked: user.password_change_locked ?? false,
  allowed_tags: '',
  allowed_login_cidrs: '',
});

/**
 * Header component
 * @param {Object} props - Component props
 * @param {string} props.version - System version
 * @returns {JSX.Element} Header component
 */
export function Header({ version = VERSION, activeNav: activeNavProp }) {
  // Get active navigation from data attribute on header container
  const headerContainer = document.getElementById('header-container');
  const activeNav = activeNavProp || headerContainer?.dataset?.activeNav || '';
  const [username, _setUsername] = useState(localStorage.getItem('username') || '');
  const [currentUser, setCurrentUser] = useState(null);
  const [profileFormData, setProfileFormData] = useState(() => buildProfileFormData());
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(true); // Default to true while loading
  const [demoMode, setDemoMode] = useState(false); // Demo mode state
  const [userRole, _setUserRole] = useState(localStorage.getItem('userrole') || null); // null = still loading
  const [sidebarState, setSidebarState] = useState(getStoredSidebarState);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);
  const [cameraListCollapsed, setCameraListCollapsed] = useState(getStoredCameraListCollapsed);
  const [expandedLayouts, setExpandedLayouts] = useState(() => getStoredExpandedTree(LAYOUT_TREE_STORAGE_KEY));
  const [liveLayouts, setLiveLayouts] = useState({ layouts: [] });
  const [openMenu, setOpenMenu] = useState(null);
  const [creatingLayout, setCreatingLayout] = useState(false);
  const [newLayoutName, setNewLayoutName] = useState('');
  const [renamingLayoutId, setRenamingLayoutId] = useState('');
  const [renameLayoutName, setRenameLayoutName] = useState('');
  const [dragOverLayoutId, setDragOverLayoutId] = useState('');
  // Camera drag onto folders: target folder id ('__unfiled__' = out of folders)
  const [dragOverFolderId, setDragOverFolderId] = useState('');
  const [draggingCameraNames, setDraggingCameraNames] = useState([]);
  const [selectedCameraNames, setSelectedCameraNames] = useState(() => new Set());
  const [cameraContextMenu, setCameraContextMenu] = useState(null);
  const [liveLayoutEditState, setLiveLayoutEditState] = useState({ layoutId: '', editing: false });
  const [locationSearch, setLocationSearch] = useState(() => (typeof window !== 'undefined' ? window.location.search : ''));
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  // Discovered addresses the admin removed from the list (saved server-side
  // in onvif_discovery_ignored so they stay hidden after later scans)
  const [ignoredDiscoveryAddresses, setIgnoredDiscoveryAddresses] = useState(() => new Set());
  const [discoveredDeviceToRemove, setDiscoveredDeviceToRemove] = useState(null);
  // Discovered (not yet added) devices sit behind a "Found cameras" toggle, closed by default
  const [foundCamerasExpanded, setFoundCamerasExpanded] = useState(false);
  // Camera folders (saved server-side via /api/camera-folders)
  const [cameraFolders, setCameraFolders] = useState([]);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState(getStoredCollapsedFolderIds);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderToDelete, setFolderToDelete] = useState(null);
  const [folderPicker, setFolderPicker] = useState(null); // { folderId, selected: Set }
  const [isDiscoveringCameras, setIsDiscoveringCameras] = useState(false);
  const { t } = useI18n();
  const suppressNextCameraClickRef = useRef(false);
  const cameraSelectionBeforeClickRef = useRef(new Set());
  const sidebarAutoDiscoveryStartedRef = useRef(false);
  const sidebarCollapsed = sidebarState.collapsed;
  const { data: sidebarStreams = [] } = useQuery(
    'streams',
    '/api/streams',
    {
      headers: getAuthHeaders(),
      timeout: 15000,
      retries: 1,
      retryDelay: 1000,
    },
    {
      refetchInterval: 30000,
    }
  );
  const { data: liveLayoutsData = { layouts: [] } } = useQuery(
    ['live-layouts'],
    '/api/live-layouts',
    {
      headers: getAuthHeaders(),
      timeout: 10000,
      retries: 1,
      retryDelay: 1000,
    },
    {
      refetchInterval: 30000,
    }
  );

  const { data: cameraFoldersData } = useQuery(
    ['camera-folders'],
    '/api/camera-folders',
    {
      headers: getAuthHeaders(),
      timeout: 10000,
      retries: 1,
      retryDelay: 1000,
    },
    {
      refetchInterval: 30000,
    }
  );

  useEffect(() => {
    if (Array.isArray(cameraFoldersData?.folders)) {
      setCameraFolders(cameraFoldersData.folders);
    }
  }, [cameraFoldersData]);

  useEffect(() => {
    try {
      localStorage.setItem(CAMERA_FOLDERS_COLLAPSED_STORAGE_KEY, JSON.stringify(Array.from(collapsedFolderIds)));
    } catch {
      // Collapsed state is a convenience only
    }
  }, [collapsedFolderIds]);

  useEffect(() => {
    startLiveWarmup();
  }, []);

  useEffect(() => {
    preloadLiveSnapshots(sidebarStreams);
  }, [sidebarStreams]);

  useEffect(() => {
    if (!cameraContextMenu) return undefined;

    const closeCameraContextMenu = () => setCameraContextMenu(null);
    window.addEventListener('click', closeCameraContextMenu);
    window.addEventListener('scroll', closeCameraContextMenu, true);
    window.addEventListener('resize', closeCameraContextMenu);
    return () => {
      window.removeEventListener('click', closeCameraContextMenu);
      window.removeEventListener('scroll', closeCameraContextMenu, true);
      window.removeEventListener('resize', closeCameraContextMenu);
    };
  }, [cameraContextMenu]);

  const sidebarCameraList = useMemo(() => (
    Array.isArray(sidebarStreams)
      ? sidebarStreams
        .filter((stream) => stream && !stream.is_deleted)
        .slice()
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
      : []
  ), [sidebarStreams]);
  const sidebarDiscoveredCameraList = useMemo(() => (
    discoveredDevices
      .filter((device) => device?.ip_address && !ignoredDiscoveryAddresses.has(device.ip_address))
      .filter((device) => !sidebarCameraList.some((stream) => {
        if (!stream) return false;
        return [stream.url, stream.secondary_url].some((streamUrl) => {
          if (!streamUrl) return false;
          try {
            return new URL(streamUrl).hostname === device.ip_address;
          } catch {
            return String(streamUrl).includes(device.ip_address);
          }
        });
      }))
      .slice()
      .sort((a, b) => String(a.ip_address || '').localeCompare(String(b.ip_address || '')))
  ), [discoveredDevices, ignoredDiscoveryAddresses, sidebarCameraList]);
  const streamByName = useMemo(() => new Map(sidebarCameraList.map((stream) => [stream.name, stream])), [sidebarCameraList]);

  // Folders with their (visible) cameras, the cameras not in any folder, and
  // the on-screen order used for keyboard navigation
  const cameraFolderView = useMemo(() => cameraFolders.map((folder) => ({
    ...folder,
    streams: (folder.cameras || []).map((name) => streamByName.get(name)).filter(Boolean),
  })), [cameraFolders, streamByName]);
  const camerasInFolders = useMemo(() => new Set(
    cameraFolderView.flatMap((folder) => folder.streams.map((stream) => stream.name))
  ), [cameraFolderView]);
  const ungroupedSidebarCameras = useMemo(() => (
    sidebarCameraList.filter((stream) => !camerasInFolders.has(stream.name))
  ), [camerasInFolders, sidebarCameraList]);
  const navigableSidebarCameras = useMemo(() => [
    ...cameraFolderView.flatMap((folder) => (collapsedFolderIds.has(folder.id) ? [] : folder.streams)),
    ...ungroupedSidebarCameras,
  ], [cameraFolderView, collapsedFolderIds, ungroupedSidebarCameras]);
  const selectedCameraNameList = useMemo(() => (
    sidebarCameraList
      .map((stream) => stream.name)
      .filter((name) => selectedCameraNames.has(name))
  ), [sidebarCameraList, selectedCameraNames]);
  const liveSelection = useMemo(() => {
    if (activeNav !== 'nav-live' || typeof window === 'undefined') {
      return { tag: '', stream: '' };
    }
    const params = new URLSearchParams(locationSearch);
    const layout = params.get('layout') || '';
    return {
      tag: params.get('tag') || '',
      stream: params.get('stream') || '',
      camera: params.get('camera') || '',
      layout: layout === 'none' || layout === 'workspace' ? '' : layout,
    };
  }, [activeNav, locationSearch]);

  useEffect(() => {
    if (sidebarCameraList.length === 0) return;

    const availableNames = new Set(sidebarCameraList.map((stream) => stream.name));
    setSelectedCameraNames((previousSelected) => {
      const nextSelected = new Set(
        [...previousSelected].filter((cameraName) => availableNames.has(cameraName))
      );
      if (
        nextSelected.size === previousSelected.size &&
        [...nextSelected].every((cameraName) => previousSelected.has(cameraName))
      ) {
        return previousSelected;
      }
      return nextSelected;
    });
  }, [sidebarCameraList]);

  const setUsername = (username) => {
    _setUsername(username);
    localStorage.setItem('username', username);
  };

  const setUserRole = (userrole) => {
    _setUserRole(userrole);
    localStorage.setItem('userrole', userrole);
  };

  const syncSessionState = useCallback((session) => {
    if (session.valid && session.role) {
      setUserRole(session.role);
    } else {
      setUserRole(session.auth_enabled === false ? 'admin' : 'viewer');
    }

    const isSessionDemoMode = session.demo_mode === true;
    setDemoMode(isSessionDemoMode);

    if (session.username) {
      setUsername(session.username);
    } else {
      setUsername('');
    }

    if (session.id) {
      const nextUser = {
        id: session.id,
        username: session.username || '',
        email: session.email || '',
        role: session.role,
        role_id: session.role_id,
        is_active: session.is_active,
        password_change_locked: session.password_change_locked,
      };
      setCurrentUser(nextUser);
      setProfileFormData(buildProfileFormData(nextUser));
    } else {
      setCurrentUser(null);
      setProfileFormData(buildProfileFormData());
    }
  }, []);

  // Get the current username, role, and check if auth is enabled
  useEffect(() => {
    validateSession()
      .then(syncSessionState)
      .catch(() => {
        setUserRole('viewer');
        if (isDemoMode()) {
          setDemoMode(true);
        } else {
          setUsername('');
        }
      });

    // Fetch settings to check if auth is enabled
    async function checkAuthEnabled() {
      try {
        const settings = await getSettings();
        console.log('Header: Fetched settings:', settings);
        console.log('Header: web_auth_enabled value:', settings.web_auth_enabled);
        const isAuthEnabled = settings.web_auth_enabled === true;
        console.log('Header: Setting authEnabled to:', isAuthEnabled);
        setAuthEnabled(isAuthEnabled);
      } catch (error) {
        console.error('Error fetching auth settings:', error);
        // Default to true on error to avoid hiding logout button unnecessarily
        setAuthEnabled(true);
      }
    }
    checkAuthEnabled();

    // Also check demo mode from global state (set during session validation)
    const checkDemoMode = () => {
      if (window._demoMode === true) {
        setDemoMode(true);
        if (!currentUser?.id) {
          setUsername('');
        }
      }
    };
    // Check initially and also set up a listener for changes
    checkDemoMode();
    // Check periodically in case demo mode was set after initial load
    const intervalId = setInterval(checkDemoMode, 1000);
    // Clean up after first successful detection
    setTimeout(() => clearInterval(intervalId), 5000);
    return () => clearInterval(intervalId);
  }, [currentUser?.id, syncSessionState]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const updateLocationSearch = () => setLocationSearch(window.location.search);
    const wrapHistoryMethod = (methodName) => {
      const original = window.history[methodName];
      window.history[methodName] = function wrappedHistoryMethod(...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event('oneberry:locationchange'));
        return result;
      };
      return original;
    };

    const originalPushState = wrapHistoryMethod('pushState');
    const originalReplaceState = wrapHistoryMethod('replaceState');

    window.addEventListener('popstate', updateLocationSearch);
    window.addEventListener('oneberry:locationchange', updateLocationSearch);

    return () => {
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      window.removeEventListener('popstate', updateLocationSearch);
      window.removeEventListener('oneberry:locationchange', updateLocationSearch);
    };
  }, []);

  useEffect(() => {
    const sidebarWidth = sidebarCollapsed ? SIDEBAR_COLLAPSED_WIDTH_REM : sidebarState.width;
    document.documentElement.style.setProperty('--dashboard-sidebar-width', `${sidebarWidth}rem`);
    document.body.classList.toggle('dashboard-sidebar-collapsed', sidebarCollapsed);
    document.body.classList.toggle('dashboard-sidebar-dragging', isDraggingSidebar);

    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify({
        collapsed: sidebarCollapsed,
        width: sidebarState.width,
      }));
    } catch (error) {
      // localStorage can fail in private browsing or locked-down embedded views.
    }

    return () => {
      document.body.classList.remove('dashboard-sidebar-dragging');
    };
  }, [isDraggingSidebar, sidebarCollapsed, sidebarState.width]);

  useEffect(() => {
    setLiveLayouts(normalizeLiveLayouts(liveLayoutsData));
  }, [liveLayoutsData]);

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_TREE_STORAGE_KEY, JSON.stringify(expandedLayouts));
    } catch (error) {
      // Ignore storage failures.
    }
  }, [expandedLayouts]);

  useEffect(() => {
    try {
      localStorage.setItem(CAMERA_LIST_COLLAPSED_STORAGE_KEY, cameraListCollapsed ? 'true' : 'false');
    } catch (error) {
      // Ignore storage failures.
    }
  }, [cameraListCollapsed]);

  useEffect(() => {
    const closeMenus = () => setOpenMenu(null);
    window.addEventListener('click', closeMenus);
    return () => window.removeEventListener('click', closeMenus);
  }, []);

  useEffect(() => {
    const handleLiveLayoutEditMode = (event) => {
      const detail = event.detail || {};
      setLiveLayoutEditState({
        layoutId: String(detail.layoutId || ''),
        editing: detail.editing === true,
      });
    };

    window.addEventListener('oneberry:live-layout-edit-mode', handleLiveLayoutEditMode);
    return () => window.removeEventListener('oneberry:live-layout-edit-mode', handleLiveLayoutEditMode);
  }, []);

  useEffect(() => {
    if (!liveLayoutEditState.editing) return;
    if (activeNav !== 'nav-live' || liveSelection.layout !== liveLayoutEditState.layoutId) {
      setLiveLayoutEditState({ layoutId: '', editing: false });
      setDragOverLayoutId('');
    }
  }, [activeNav, liveLayoutEditState.editing, liveLayoutEditState.layoutId, liveSelection.layout]);

  const toggleLayoutNode = useCallback((nodeKey) => {
    setExpandedLayouts((prevState) => ({
      ...prevState,
      [nodeKey]: prevState[nodeKey] === false,
    }));
  }, []);

  const handleProfileInputChange = useCallback((e) => {
    const { name, value, type, checked } = e.target;
    setProfileFormData(prevData => ({
      ...prevData,
      [name]: type === 'checkbox' ? checked : value,
    }));
  }, []);

  const openProfileModal = useCallback(() => {
    if (!currentUser?.id) {
      return;
    }

    setProfileFormData(buildProfileFormData(currentUser));
    setIsProfileModalOpen(true);
    setMobileMenuOpen(false);
  }, [currentUser]);

  const closeProfileModal = useCallback(() => {
    setIsProfileModalOpen(false);
  }, []);

  const handleProfileSave = useCallback(async (e) => {
    if (e) {
      e.preventDefault();
    }

    if (!currentUser?.id || isSavingProfile) {
      return;
    }

    setIsSavingProfile(true);
    try {
      const payload = {
        username: profileFormData.username.trim(),
        email: profileFormData.email.trim(),
      };
      if (profileFormData.password) {
        payload.password = profileFormData.password;
      }
      const updatedUser = await fetchJSON(`/api/auth/users/${currentUser.id}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify(payload),
        timeout: 15000,
        retries: 1,
        retryDelay: 1000,
      });

      const nextUser = {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email || '',
        role: currentUser.role,
        role_id: updatedUser.role,
        is_active: updatedUser.is_active,
        password_change_locked: updatedUser.password_change_locked,
      };

      setCurrentUser(nextUser);
      setProfileFormData(buildProfileFormData(nextUser));
      setUsername(updatedUser.username);
      setIsProfileModalOpen(false);
      showStatusMessage(t('auth.profileUpdated'), 'success', 5000);
    } catch (error) {
      console.error('Error updating current user:', error);
      showStatusMessage(t('auth.profileUpdateError', { message: error.message }), 'error', 8000);
    } finally {
      setIsSavingProfile(false);
    }
  }, [currentUser, isSavingProfile, profileFormData.email, profileFormData.password, profileFormData.username, t]);

  // Toggle mobile menu
  const toggleMobileMenu = () => {
    setMobileMenuOpen(!mobileMenuOpen);
  };

  const toggleSidebarCollapsed = useCallback(() => {
    setSidebarState((prevState) => ({
      collapsed: !prevState.collapsed,
      width: Math.min(SIDEBAR_MAX_WIDTH_REM, Math.max(SIDEBAR_MIN_WIDTH_REM, prevState.width || SIDEBAR_EXPANDED_WIDTH_REM)),
    }));
  }, []);

  const handleSidebarDragStart = useCallback((event) => {
    if (window.innerWidth < 1024) {
      return;
    }

    event.preventDefault();
    setIsDraggingSidebar(true);

    const getRootFontSize = () => parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;

    const handlePointerMove = (moveEvent) => {
      const nextWidthRem = moveEvent.clientX / getRootFontSize();

      if (nextWidthRem <= SIDEBAR_COLLAPSE_THRESHOLD_REM) {
        setSidebarState((prevState) => ({
          ...prevState,
          collapsed: true,
        }));
        return;
      }

      setSidebarState({
        collapsed: false,
        width: Math.min(SIDEBAR_MAX_WIDTH_REM, Math.max(SIDEBAR_MIN_WIDTH_REM, Number(nextWidthRem.toFixed(2)))),
      });
    };

    const stopDragging = () => {
      setIsDraggingSidebar(false);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopDragging);
      window.removeEventListener('pointercancel', stopDragging);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
  }, []);

  // Determine if the current user has admin access for nav filtering.
  // While the role is still loading (null) we conservatively show all items
  // so the nav doesn't flash/reorder after load.
  const isAdmin = userRole === null || userRole === 'admin';
  const canDiscoverSidebarCameras = userRole === 'admin' && !demoMode;
  // Same rule as the Streams page: admins and users may edit/delete, viewers may not
  const canManageSidebarCameras = (userRole === null || userRole === 'admin' || userRole === 'user') && !demoMode;
  const canEditCurrentUser = authEnabled && !demoMode && Boolean(currentUser?.id);
  const displayUsername = username || (demoMode ? t('auth.demoViewer') : t('auth.user'));

  // Navigation items - don't preserve query parameters when navigating via header
  // Admin-only tabs (System, Users) are hidden from non-admin roles.
  const navItems = [
    { id: 'nav-recordings', href: 'recordings.html', label: t('nav.recordings') },
    { id: 'nav-streams', href: 'streams.html', label: t('live.manageCameras') },
    { id: 'nav-settings', href: 'settings.html', label: t('nav.settings') },
    ...(isAdmin ? [{ id: 'nav-camera-access', href: 'camera-access.html', label: t('nav.cameraAccess') }] : []),
    ...(isAdmin ? [{ id: 'nav-users', href: 'users.html', label: t('nav.users') }] : []),
    ...(isAdmin ? [{ id: 'nav-system', href: 'system.html', label: t('nav.system') }] : []),
  ];

  const loadSidebarDiscoveryStatus = useCallback(async () => {
    if (!canDiscoverSidebarCameras) {
      setDiscoveredDevices([]);
      setIsDiscoveringCameras(false);
      return null;
    }

    try {
      const data = await fetchJSON('/api/discovery/cameras/status', {
        timeout: 5000,
        retries: 0,
      });
      setDiscoveredDevices((previousDevices) => mergeDiscoveredDevices(previousDevices, data.devices || []));
      setIsDiscoveringCameras(data.running === true && !data.completed);
      return data;
    } catch (error) {
      console.warn('Unable to load sidebar camera discovery status:', error);
      return null;
    }
  }, [canDiscoverSidebarCameras]);

  useEffect(() => {
    if (!canDiscoverSidebarCameras) return undefined;
    let cancelled = false;
    fetchJSON('/api/settings', { timeout: 5000, retries: 0 })
      .then((settings) => {
        if (cancelled) return;
        const saved = String(settings?.onvif_discovery_ignored || '')
          .split(',')
          .map((address) => address.trim())
          .filter(Boolean);
        setIgnoredDiscoveryAddresses(new Set(saved));
      })
      .catch((error) => console.warn('Could not load removed discovery addresses:', error));
    return () => { cancelled = true; };
  }, [canDiscoverSidebarCameras]);

  const removeDiscoveredDevice = useCallback(async (device) => {
    const address = device?.ip_address;
    if (!address) return;

    const previous = ignoredDiscoveryAddresses;
    const next = new Set(previous);
    next.add(address);
    setIgnoredDiscoveryAddresses(next);

    try {
      await fetchJSON('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ onvif_discovery_ignored: Array.from(next).join(',') }),
        timeout: 10000,
        retries: 0,
      });
      showStatusMessage(`Removed ${device.name || address} from the camera list`, 'success', 3000);
    } catch (error) {
      setIgnoredDiscoveryAddresses(previous);
      showStatusMessage(`Could not remove ${address}: ${error.message}`, 'error', 5000);
    }
  }, [ignoredDiscoveryAddresses]);

  const startSidebarCameraDiscovery = useCallback(async () => {
    if (!canDiscoverSidebarCameras) {
      return null;
    }

    let discoveryNetwork = 'auto';
    try {
      const settings = await fetchJSON('/api/settings', { timeout: 5000 });
      if (settings?.onvif_discovery_network) {
        discoveryNetwork = settings.onvif_discovery_network;
      }
    } catch (error) {
      console.warn('Could not fetch camera discovery network setting, using auto', error);
    }

    try {
      setIsDiscoveringCameras(true);
      const data = await fetchJSON('/api/discovery/cameras', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({
          network: discoveryNetwork,
          include_onvif: true,
          include_rtsp: false,
        }),
        timeout: 15000,
        retries: 0,
      });
      setDiscoveredDevices((previousDevices) => mergeDiscoveredDevices(previousDevices, data.devices || []));
      setIsDiscoveringCameras(data.running === true && !data.completed);
      return data;
    } catch (error) {
      console.warn('Sidebar camera discovery failed:', error);
      setIsDiscoveringCameras(false);
      return null;
    }
  }, [canDiscoverSidebarCameras]);

  useEffect(() => {
    let cancelled = false;

    const hydrateDiscovery = async () => {
      const status = await loadSidebarDiscoveryStatus();
      if (cancelled || sidebarAutoDiscoveryStartedRef.current || !canDiscoverSidebarCameras) {
        return;
      }

      sidebarAutoDiscoveryStartedRef.current = true;
      if (!status?.running) {
        await startSidebarCameraDiscovery();
      }
    };

    hydrateDiscovery();
    const intervalId = window.setInterval(loadSidebarDiscoveryStatus, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [canDiscoverSidebarCameras, loadSidebarDiscoveryStatus, startSidebarCameraDiscovery]);

  useEffect(() => {
    if (!isDiscoveringCameras) return undefined;

    const intervalId = window.setInterval(loadSidebarDiscoveryStatus, 1500);
    return () => window.clearInterval(intervalId);
  }, [isDiscoveringCameras, loadSidebarDiscoveryStatus]);

  // Render navigation item
  const renderNavItem = (item, mobile = false) => {
    const isActive = activeNav === item.id;
    const baseClasses = "sidebar-nav-link no-underline cursor-pointer border-0 font-medium " + (item.baseClasses || "");
    const activeClass = isActive ? 'is-active' : '';

    const isDisabled = item.disabled === true;
    return (
        <li className={item.classNameLi || ""}>
          <a
              href={isDisabled ? undefined : item.href}
              id={item.id}
              title={item.title || item.label}
              aria-disabled={isDisabled || undefined}
              className={`${baseClasses} ${mobile ? 'is-mobile' : ''} ${activeClass}${isDisabled ? ' is-disabled' : ''}`}
              onClick={(e) => {
                if (isDisabled) return;

                // Force navigation and prevent default behavior
                if (item.href) {
                  navigateToAppPage(item.href, e);
                }

                // Call onClick function if provided
                if (item.onClick) {
                  item.onClick(e);
                }

                // Close mobile menu if open
                if (mobileMenuOpen) {
                  toggleMobileMenu();
                }
              }}
          >
            <NavIcon id={item.id} />
            <span className="sidebar-nav-label">{item.label}</span>
          </a>
        </li>
    );
  };

  const renderUsername = (mobile = false) => {
    return renderNavItem({
      id: 'nav-editProfile',
      title: t('auth.editProfile'),
      disabled: !canEditCurrentUser,
      onClick: openProfileModal,
      label: displayUsername,
    }, mobile);
  };

  const renderCreateUserGroup = (mobile = false) => {
    return renderNavItem({
      id: 'nav-user-groups',
      href: 'camera-access.html?tab=user&action=create',
      title: t('cameraAccess.createUserGroup'),
      label: t('cameraAccess.newUserGroup'),
    }, mobile);
  };

  const renderLoginLogout = (login = false, mobile = false) => {
    return renderNavItem({
      id: login ? 'nav-login' : 'nav-logout',
      href: login ? "/login.html" : "/logout",
      label: login ? t('auth.login') : t('auth.logout'),
      baseClasses: (mobile ? 'text-right ' : '') + (login ? 'login-link' : 'logout-link'),
    }, mobile);
  };

  const saveLiveLayouts = useCallback(async (nextLayouts, previousLayouts = liveLayouts) => {
    const normalized = normalizeLiveLayouts(nextLayouts);
    setLiveLayouts(normalized);
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
      setLiveLayouts(savedLayouts);
      queryClient.setQueryData(['live-layouts'], savedLayouts);
      return savedLayouts;
    } catch (error) {
      const rollback = normalizeLiveLayouts(previousLayouts);
      setLiveLayouts(rollback);
      queryClient.setQueryData(['live-layouts'], rollback);
      showStatusMessage(error.message || 'Failed to save layouts', 'error', 8000);
      return rollback;
    }
  }, [liveLayouts]);

  const handleCreateLayout = useCallback(async (event) => {
    if (event) event.preventDefault();
    const name = newLayoutName.trim();
    if (!name) return;

    const previous = liveLayouts;
    const next = {
      layouts: [
        ...liveLayouts.layouts,
        {
          id: createLayoutId(),
          name,
          cols: WORKSPACE_GRID_COLS,
          rows: WORKSPACE_GRID_ROWS,
          tiles: [],
          cameras: [],
        },
      ],
    };
    setCreatingLayout(false);
    setNewLayoutName('');
    await saveLiveLayouts(next, previous);
  }, [liveLayouts, newLayoutName, saveLiveLayouts]);

  const startCreateLayout = useCallback(() => {
    setCreatingLayout(true);
    setOpenMenu(null);
    setCameraContextMenu(null);
  }, []);

  const startRenameLayout = useCallback((layout) => {
    setRenamingLayoutId(layout.id);
    setRenameLayoutName(layout.name);
    setOpenMenu(null);
  }, []);

  const handleRenameLayout = useCallback(async (event) => {
    if (event) event.preventDefault();
    const name = renameLayoutName.trim();
    if (!name || !renamingLayoutId) return;

    const previous = liveLayouts;
    const next = {
      layouts: liveLayouts.layouts.map((layout) => (
        layout.id === renamingLayoutId ? { ...layout, name } : layout
      )),
    };
    setRenamingLayoutId('');
    setRenameLayoutName('');
    await saveLiveLayouts(next, previous);
  }, [liveLayouts, renameLayoutName, renamingLayoutId, saveLiveLayouts]);

  const deleteLayout = useCallback(async (layoutId) => {
    const previous = liveLayouts;
    const next = {
      layouts: liveLayouts.layouts.filter((layout) => layout.id !== layoutId),
    };
    setOpenMenu(null);
    await saveLiveLayouts(next, previous);
  }, [liveLayouts, saveLiveLayouts]);

  const canEditSidebarLayout = useCallback((layoutId) => (
    activeNav === 'nav-live' &&
    liveSelection.layout === layoutId &&
    liveLayoutEditState.editing &&
    liveLayoutEditState.layoutId === layoutId
  ), [activeNav, liveLayoutEditState.editing, liveLayoutEditState.layoutId, liveSelection.layout]);

  const addCamerasToLayout = useCallback(async (layoutId, cameraNames) => {
    const cameras = getCameraNameList(cameraNames);
    if (cameras.length === 0) return;

    if (canEditSidebarLayout(layoutId)) {
      window.dispatchEvent(new CustomEvent('oneberry:add-live-camera', {
        detail: { cameraNames: cameras, cameraName: cameras[0], autoFit: false },
      }));
      return;
    }

    const previous = liveLayouts;
    const next = {
      layouts: liveLayouts.layouts.map((layout) => {
        if (layout.id !== layoutId) {
          return layout;
        }
        const tiles = Array.isArray(layout.tiles) ? layout.tiles : [];
        const nextTiles = buildResponsiveLayoutTiles([
          ...tiles,
          ...cameras.map((camera, index) => createLayoutTile(camera, tiles.length + index)),
        ]);
        return {
          ...layout,
          cols: WORKSPACE_GRID_COLS,
          rows: WORKSPACE_GRID_ROWS,
          tiles: nextTiles,
          cameras: nextTiles.map((tile) => tile.camera),
        };
      }),
    };

    await saveLiveLayouts(next, previous);
  }, [canEditSidebarLayout, liveLayouts, saveLiveLayouts]);

  const removeCameraFromLayout = useCallback((layoutId, tile) => {
    if (!canEditSidebarLayout(layoutId) || !tile) return;
    window.dispatchEvent(new CustomEvent('oneberry:remove-live-layout-camera', {
      detail: {
        layoutId,
        tileId: tile.id,
        cameraName: tile.camera,
      },
    }));
  }, [canEditSidebarLayout]);

  const handleOpenLayout = useCallback((layoutId, event) => {
    const href = makeLiveHref({ layout: layoutId });
    if (activeNav !== 'nav-live' || typeof window === 'undefined') {
      navigateToAppPage(href, event);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent('oneberry:show-live-layout', {
      detail: { layoutId },
    }));
  }, [activeNav]);

  const handleOpenLayoutCamera = useCallback((layoutId, cameraId, event) => {
    const href = makeLiveHref({ layout: layoutId, camera: cameraId });
    if (activeNav !== 'nav-live' || typeof window === 'undefined') {
      navigateToAppPage(href, event);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    window.dispatchEvent(new CustomEvent('oneberry:show-live-layout-camera', {
      detail: { layoutId, cameraId },
    }));
  }, [activeNav]);

  const handleCameraDragStart = useCallback((event) => {
    const cameraName = event.currentTarget?.dataset?.cameraId || '';
    if (!cameraName) return;

    suppressNextCameraClickRef.current = true;
    const cameraNames = selectedCameraNames.has(cameraName) && selectedCameraNameList.length > 0
      ? selectedCameraNameList
      : [cameraName];
    // copy onto layouts, move into folders
    event.dataTransfer.effectAllowed = 'copyMove';
    event.dataTransfer.setData('text/plain', cameraNames[0]);
    event.dataTransfer.setData('application/x-oneberry-camera', cameraNames[0]);
    event.dataTransfer.setData('application/x-oneberry-cameras', JSON.stringify(cameraNames));
    setSelectedCameraNames(new Set());
    cameraSelectionBeforeClickRef.current = new Set();
    setCameraContextMenu(null);
    setDraggingCameraNames(cameraNames);
  }, [selectedCameraNameList, selectedCameraNames]);

  const handleCameraDragEnd = useCallback(() => {
    setDraggingCameraNames([]);
    setDragOverFolderId('');
    window.setTimeout(() => {
      suppressNextCameraClickRef.current = false;
    }, 50);
  }, []);

  const handleSourceCameraClick = useCallback((event) => {
    const cameraName = event.currentTarget?.dataset?.cameraId || '';
    if (!cameraName) return;

    event.preventDefault();
    if (event.detail > 1) return;
    if (suppressNextCameraClickRef.current) return;

    setCameraContextMenu(null);
    setSelectedCameraNames((previousSelected) => {
      cameraSelectionBeforeClickRef.current = new Set(previousSelected);
      const nextSelected = new Set(previousSelected);
      if (nextSelected.has(cameraName)) {
        nextSelected.delete(cameraName);
      } else {
        nextSelected.add(cameraName);
      }
      return nextSelected;
    });
  }, []);

  const handleSourceCameraDoubleClick = useCallback((event) => {
    const cameraName = event.currentTarget?.dataset?.cameraId || '';
    if (!cameraName) return;

    if (activeNav !== 'nav-live' || typeof window === 'undefined') {
      const cameraNames = [cameraName];
      try {
        sessionStorage.setItem(PENDING_BLANK_WORKSPACE_CAMERAS_KEY, JSON.stringify(cameraNames));
      } catch {
        // Storage can fail in locked-down browser contexts; the blank workspace still opens.
      }
      setSelectedCameraNames(new Set());
      cameraSelectionBeforeClickRef.current = new Set();
      setCameraContextMenu(null);
      navigateToAppPage(makeLiveHref({ layout: 'workspace' }), event);
      return;
    }

    const selectedBeforeClick = cameraSelectionBeforeClickRef.current;
    const cameraNames = selectedBeforeClick.has(cameraName)
      ? sidebarCameraList
        .map((stream) => stream.name)
        .filter((name) => selectedBeforeClick.has(name))
      : selectedCameraNames.has(cameraName) && selectedCameraNameList.length > 0
        ? selectedCameraNameList
        : [cameraName];
    const activationCameraNames = cameraNames.length > 0
      ? cameraNames
      : [cameraName];
    if (!liveSelection.layout) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('oneberry:add-live-camera', {
        detail: { cameraNames: activationCameraNames, cameraName: activationCameraNames[0], autoFit: true },
      }));
      setSelectedCameraNames(new Set());
      cameraSelectionBeforeClickRef.current = new Set();
      setCameraContextMenu(null);
      return;
    }

    if (canEditSidebarLayout(liveSelection.layout)) {
      event.preventDefault();
      window.dispatchEvent(new CustomEvent('oneberry:add-live-camera', {
        detail: { cameraNames: activationCameraNames, cameraName: activationCameraNames[0], autoFit: false },
      }));
      setSelectedCameraNames(new Set());
      cameraSelectionBeforeClickRef.current = new Set();
      setCameraContextMenu(null);
      return;
    }

    setSelectedCameraNames(new Set());
    cameraSelectionBeforeClickRef.current = new Set();
    setCameraContextMenu(null);
    navigateToAppPage(makeLiveHref({ layout: 'none', stream: cameraName }), event);
  }, [activeNav, canEditSidebarLayout, liveSelection.layout, selectedCameraNameList, selectedCameraNames, sidebarCameraList]);

  const handleSourceCameraKeyDown = useCallback((event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

    const cameraCount = navigableSidebarCameras.length;
    if (cameraCount === 0) return;

    event.preventDefault();
    setCameraContextMenu(null);
    const anchorCameraName = selectedCameraNameList[selectedCameraNameList.length - 1] || '';
    const selectedIndex = navigableSidebarCameras.findIndex((stream) => stream.name === anchorCameraName);
    const nextIndex = event.key === 'ArrowDown'
      ? (selectedIndex < 0 ? 0 : Math.min(cameraCount - 1, selectedIndex + 1))
      : (selectedIndex < 0 ? cameraCount - 1 : Math.max(0, selectedIndex - 1));
    const nextCameraId = navigableSidebarCameras[nextIndex]?.name || '';
    if (nextCameraId) {
      setSelectedCameraNames(new Set([nextCameraId]));
    }
  }, [selectedCameraNameList, navigableSidebarCameras]);

  const handleSourceCameraContextMenu = useCallback((event) => {
    const cameraName = event.currentTarget?.dataset?.cameraId || '';
    if (!cameraName) return;

    event.preventDefault();
    setOpenMenu(null);
    setSelectedCameraNames((previousSelected) => {
      if (previousSelected.has(cameraName)) return previousSelected;
      return new Set([cameraName]);
    });
    setCameraContextMenu({
      cameraName,
      x: event.clientX,
      y: event.clientY,
    });
  }, []);

  const handleAddContextCamerasToWorkspace = useCallback(() => {
    if (!cameraContextMenu) return;
    const cameraNames = selectedCameraNames.has(cameraContextMenu.cameraName) && selectedCameraNameList.length > 0
      ? selectedCameraNameList
      : [cameraContextMenu.cameraName];

    window.dispatchEvent(new CustomEvent('oneberry:add-live-camera', {
      detail: { cameraNames, cameraName: cameraNames[0], autoFit: false },
    }));
    setSelectedCameraNames(new Set());
    cameraSelectionBeforeClickRef.current = new Set();
    setCameraContextMenu(null);
  }, [cameraContextMenu, selectedCameraNameList, selectedCameraNames]);

  const handleAddContextCamerasToLayout = useCallback(async (layoutId) => {
    if (!cameraContextMenu) return;
    const cameraNames = selectedCameraNames.has(cameraContextMenu.cameraName) && selectedCameraNameList.length > 0
      ? selectedCameraNameList
      : [cameraContextMenu.cameraName];

    await addCamerasToLayout(layoutId, cameraNames);
    setSelectedCameraNames(new Set());
    cameraSelectionBeforeClickRef.current = new Set();
    setCameraContextMenu(null);
  }, [addCamerasToLayout, cameraContextMenu, selectedCameraNameList, selectedCameraNames]);

  const handleCreateContextLayout = useCallback(() => {
    if (!cameraContextMenu) return;
    const cameraNames = selectedCameraNames.has(cameraContextMenu.cameraName) && selectedCameraNameList.length > 0
      ? selectedCameraNameList
      : [cameraContextMenu.cameraName];

    setSelectedCameraNames(new Set());
    cameraSelectionBeforeClickRef.current = new Set();
    setCameraContextMenu(null);

    if (activeNav === 'nav-live' && typeof window !== 'undefined') {
      navigateToAppPage(makeLiveHref({ layout: 'workspace' }));
      window.dispatchEvent(new CustomEvent('oneberry:open-blank-live-layout', {
        detail: { cameraNames, cameraName: cameraNames[0] },
      }));
      return;
    }

    try {
      sessionStorage.setItem(PENDING_BLANK_WORKSPACE_CAMERAS_KEY, JSON.stringify(cameraNames));
    } catch {
      // Storage can fail in locked-down browser contexts; the blank workspace still opens.
    }
    navigateToAppPage(makeLiveHref({ layout: 'workspace' }));
  }, [activeNav, cameraContextMenu, selectedCameraNameList, selectedCameraNames]);

  const saveCameraFolders = useCallback(async (nextFolders) => {
    const previous = cameraFolders;
    setCameraFolders(nextFolders);
    try {
      const saved = await fetchJSON('/api/camera-folders', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          ...getAuthHeaders(),
        },
        body: JSON.stringify({ folders: nextFolders }),
        timeout: 10000,
        retries: 0,
      });
      setCameraFolders(saved?.folders || nextFolders);
      queryClient.setQueryData(['camera-folders'], saved);
      return true;
    } catch (error) {
      setCameraFolders(previous);
      showStatusMessage(error.message || 'Failed to save camera folders', 'error', 6000);
      return false;
    }
  }, [cameraFolders]);

  const startCreateFolder = useCallback(() => {
    setOpenMenu(null);
    setCameraContextMenu(null);
    setCameraListCollapsed(false);
    setCreatingFolder(true);
  }, []);

  const handleCreateFolder = useCallback(async (event) => {
    if (event) event.preventDefault();
    const name = newFolderName.trim();
    if (!name) return;
    if (cameraFolders.some((folder) => folder.name.toLowerCase() === name.toLowerCase())) {
      showStatusMessage(`A folder named "${name}" already exists`, 'error', 5000);
      return;
    }
    setCreatingFolder(false);
    setNewFolderName('');
    await saveCameraFolders([...cameraFolders, { id: createCameraFolderId(), name, cameras: [] }]);
  }, [cameraFolders, newFolderName, saveCameraFolders]);

  const toggleFolderCollapsed = useCallback((folderId) => {
    setCollapsedFolderIds((previous) => {
      const next = new Set(previous);
      if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
      return next;
    });
  }, []);

  // Open the Add Camera form with this folder selected; the Streams page
  // files the new camera into it after it is saved
  const addNewCameraToFolder = useCallback((folder, event) => {
    setOpenMenu(null);
    setCollapsedFolderIds((previous) => {
      const next = new Set(previous);
      next.delete(folder.id);
      return next;
    });
    navigateToAppPage(`streams.html?add=1&folder=${encodeURIComponent(folder.id)}`, event);
  }, []);

  const openFolderCameraPicker = useCallback((folder) => {
    setOpenMenu(null);
    setFolderPicker({ folderId: folder.id, selected: new Set(folder.cameras || []) });
  }, []);

  // Save the picker: the folder holds exactly the checked cameras; a checked
  // camera is moved out of any other folder (a camera is in one folder only)
  const saveFolderCameraPicker = useCallback(async () => {
    if (!folderPicker) return;
    const { folderId, selected } = folderPicker;
    const ordered = sidebarCameraList.map((stream) => stream.name).filter((name) => selected.has(name));
    const nextFolders = cameraFolders.map((folder) => (
      folder.id === folderId
        ? { ...folder, cameras: ordered }
        : { ...folder, cameras: (folder.cameras || []).filter((name) => !selected.has(name)) }
    ));
    setFolderPicker(null);
    if (await saveCameraFolders(nextFolders)) {
      setCollapsedFolderIds((previous) => {
        const next = new Set(previous);
        next.delete(folderId);
        return next;
      });
    }
  }, [cameraFolders, folderPicker, saveCameraFolders, sidebarCameraList]);

  // Move cameras into a folder (folderId) or out of all folders (null). A
  // camera is only ever in one folder, so it leaves any other folder first.
  const moveCamerasToFolder = useCallback(async (folderId, cameraNames) => {
    const names = Array.from(new Set(cameraNames)).filter((name) => streamByName.has(name));
    if (names.length === 0) return;
    const moving = new Set(names);
    const target = folderId ? cameraFolders.find((folder) => folder.id === folderId) : null;
    if (folderId && !target) return;
    const alreadyThere = target && names.every((name) => (target.cameras || []).includes(name));
    const inAnyFolder = names.some((name) => cameraFolders.some((folder) => (folder.cameras || []).includes(name)));
    if (alreadyThere || (!folderId && !inAnyFolder)) return;

    const nextFolders = cameraFolders.map((folder) => {
      const kept = (folder.cameras || []).filter((name) => !moving.has(name));
      return folder.id === folderId ? { ...folder, cameras: [...kept, ...names] } : { ...folder, cameras: kept };
    });
    if (await saveCameraFolders(nextFolders)) {
      if (folderId) {
        setCollapsedFolderIds((previous) => {
          const next = new Set(previous);
          next.delete(folderId);
          return next;
        });
      }
      const label = names.length === 1 ? names[0] : `${names.length} cameras`;
      showStatusMessage(folderId ? `Moved ${label} to ${target.name}` : `Removed ${label} from its folder`, 'success', 2500);
    }
  }, [cameraFolders, saveCameraFolders, streamByName]);

  const readDraggedCameraNames = (event) => {
    const types = Array.from(event.dataTransfer.types || []);
    if (types.includes('application/x-oneberry-cameras')) {
      try {
        const names = getCameraNameList(JSON.parse(event.dataTransfer.getData('application/x-oneberry-cameras')));
        if (names.length > 0) return names;
      } catch {
        // fall back to the single camera below
      }
    }
    const single = event.dataTransfer.getData('application/x-oneberry-camera') || event.dataTransfer.getData('text/plain');
    return single ? [single] : [];
  };

  // Drag-and-drop handlers for a folder row (or, with null, the "out of folders" zone)
  const folderDropProps = (folderId) => (canManageSidebarCameras ? {
    onDragOver: (event) => {
      if (!Array.from(event.dataTransfer.types || []).includes('application/x-oneberry-camera')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const key = folderId || '__unfiled__';
      if (dragOverFolderId !== key) setDragOverFolderId(key);
    },
    onDragLeave: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setDragOverFolderId('');
    },
    onDrop: (event) => {
      if (!Array.from(event.dataTransfer.types || []).includes('application/x-oneberry-camera')) return;
      event.preventDefault();
      setDragOverFolderId('');
      setDraggingCameraNames([]);
      moveCamerasToFolder(folderId, readDraggedCameraNames(event));
    },
  } : {});

  const removeCameraFromFolder = useCallback((cameraName) => {
    setOpenMenu(null);
    saveCameraFolders(cameraFolders.map((folder) => ({
      ...folder,
      cameras: (folder.cameras || []).filter((name) => name !== cameraName),
    })));
  }, [cameraFolders, saveCameraFolders]);

  const requestDeleteFolder = useCallback((folder) => {
    setOpenMenu(null);
    if (folder.streams.length > 0) {
      showStatusMessage(`"${folder.name}" still has cameras. Remove them from the folder first.`, 'error', 5000);
      return;
    }
    setFolderToDelete(folder);
  }, []);

  const deleteFolder = useCallback((folder) => {
    if (!folder) return;
    saveCameraFolders(cameraFolders.filter((item) => item.id !== folder.id));
  }, [cameraFolders, saveCameraFolders]);

  // Sidebar camera ⋮ menu: Edit and Delete hand off to the Streams page,
  // which opens its existing edit form or delete confirmation.
  const toggleCameraMenu = useCallback((cameraName) => {
    setCameraContextMenu(null);
    setOpenMenu((current) => (current === `camera:${cameraName}` ? null : `camera:${cameraName}`));
  }, []);

  const editCameraFromSidebar = useCallback((cameraName, event) => {
    setOpenMenu(null);
    navigateToAppPage(`streams.html?edit=${encodeURIComponent(cameraName)}`, event);
  }, []);

  const deleteCameraFromSidebar = useCallback((cameraName, event) => {
    setOpenMenu(null);
    navigateToAppPage(`streams.html?delete=${encodeURIComponent(cameraName)}`, event);
  }, []);

  const openDiscoveredCameraInStreams = useCallback((event, device) => {
    if (!device?.ip_address) return;

    try {
      sessionStorage.setItem(DISCOVERY_CAMERA_HANDOFF_KEY, JSON.stringify({
        ip_address: device.ip_address,
        device,
        requested_at: Date.now(),
      }));
    } catch (error) {
      // Storage can fail in locked-down browser contexts; the query string still carries the IP.
    }

    navigateToAppPage(`streams.html?discover=1&camera=${encodeURIComponent(device.ip_address)}`, event);
  }, []);

  const renderSidebarCameraRow = (stream, inFolder) => {
    const cameraHref = makeLiveHref({ cols: 1, rows: 1, stream: stream.name });
    const statusKind = getStreamStatusKind(stream);
    return (
      <SidebarCameraRow
        key={stream.name}
        cameraHref={cameraHref}
        cameraName={stream.name}
        statusKind={statusKind}
        statusLabel={t(`sidebar.status.${statusKind}`)}
        isActive={activeNav === 'nav-live' && liveSelection.stream === stream.name}
        isSelected={selectedCameraNames.has(stream.name)}
        onCameraClick={handleSourceCameraClick}
        onCameraDoubleClick={handleSourceCameraDoubleClick}
        onCameraDragStart={handleCameraDragStart}
        onCameraDragEnd={handleCameraDragEnd}
        onCameraContextMenu={handleSourceCameraContextMenu}
        canManage={canManageSidebarCameras}
        menuOpen={openMenu === `camera:${stream.name}`}
        onMenuToggle={toggleCameraMenu}
        onEdit={editCameraFromSidebar}
        onDelete={deleteCameraFromSidebar}
        inFolder={inFolder}
        onRemoveFromFolder={removeCameraFromFolder}
      />
    );
  };

  const renderCameraFolder = (folder) => {
    const expanded = !collapsedFolderIds.has(folder.id);
    const menuKey = `folder:${folder.id}`;
    const isEmpty = folder.streams.length === 0;
    return (
      <Fragment key={`folder-${folder.id}`}>
        <li
          className={`sidebar-camera-folder ${openMenu === menuKey ? 'is-menu-open' : ''} ${dragOverFolderId === folder.id ? 'is-drop-target' : ''}`}
          role="presentation"
          data-folder-id={folder.id}
          {...folderDropProps(folder.id)}
        >
          <button
            type="button"
            className="sidebar-camera-folder-toggle"
            aria-expanded={expanded}
            onClick={() => toggleFolderCollapsed(folder.id)}
            title={folder.name}
          >
            <span className="sidebar-camera-folder-chevron" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 6l6 6-6 6" />
              </svg>
            </span>
            <TreeIcon type="folder" />
            <span className="sidebar-camera-name">{folder.name}</span>
            <span className="sidebar-tree-count">{folder.streams.length}</span>
          </button>
          {canManageSidebarCameras && (
            <div className="sidebar-layout-menu-wrap sidebar-camera-menu-wrap" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="sidebar-kebab-button"
                aria-label={`Open ${folder.name} folder menu`}
                aria-haspopup="menu"
                aria-expanded={openMenu === menuKey}
                onClick={(event) => {
                  event.stopPropagation();
                  setCameraContextMenu(null);
                  setOpenMenu((current) => (current === menuKey ? null : menuKey));
                }}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                  <circle cx="8" cy="3.25" r="1.2" />
                  <circle cx="8" cy="8" r="1.2" />
                  <circle cx="8" cy="12.75" r="1.2" />
                </svg>
              </button>
              {openMenu === menuKey && (
                <div className="sidebar-layout-menu" role="menu">
                  {isAdmin && !demoMode && (
                    <button type="button" role="menuitem" onClick={(event) => addNewCameraToFolder(folder, event)}>Add new camera</button>
                  )}
                  <button type="button" role="menuitem" onClick={() => openFolderCameraPicker(folder)}>Move cameras here</button>
                  <button
                    type="button"
                    role="menuitem"
                    className="is-danger"
                    disabled={!isEmpty}
                    title={isEmpty ? '' : 'Remove the cameras from this folder before deleting it'}
                    onClick={() => requestDeleteFolder(folder)}
                  >
                    Delete folder
                  </button>
                  {!isEmpty && <div className="sidebar-layout-menu-hint">Only empty folders can be deleted</div>}
                </div>
              )}
            </div>
          )}
        </li>
        {expanded && folder.streams.map((stream) => renderSidebarCameraRow(stream, true))}
        {expanded && isEmpty && (
          <li className="sidebar-camera-folder-empty" role="presentation">Empty folder</li>
        )}
      </Fragment>
    );
  };

  const renderCameraList = () => {
    const createFolderForm = creatingFolder && (
      <form className="sidebar-layout-inline-form" onSubmit={handleCreateFolder}>
        <input
          type="text"
          value={newFolderName}
          autoFocus
          maxLength="96"
          placeholder="Folder name"
          onInput={(event) => setNewFolderName(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setCreatingFolder(false);
              setNewFolderName('');
            }
          }}
        />
        <button type="submit" disabled={!newFolderName.trim()}>Save</button>
      </form>
    );

    if (sidebarCameraList.length === 0 && cameraFolderView.length === 0) {
      return (
        <>
          {createFolderForm}
          <div className="sidebar-building-empty">No cameras</div>
        </>
      );
    }

    return (
      <>
        {createFolderForm}
        <ul
          className="sidebar-camera-tree sidebar-live-camera-list"
          role="listbox"
          aria-label="Camera list"
          tabIndex={0}
          onKeyDown={handleSourceCameraKeyDown}
        >
          {cameraFolderView.map(renderCameraFolder)}
          {canManageSidebarCameras && draggingCameraNames.some((name) => camerasInFolders.has(name)) && (
            <li
              role="presentation"
              data-testid="sidebar-unfile-zone"
              className={`sidebar-camera-unfile-zone ${dragOverFolderId === '__unfiled__' ? 'is-drop-target' : ''}`}
              {...folderDropProps(null)}
            >
              Drop here to remove from folder
            </li>
          )}
          {ungroupedSidebarCameras.map((stream) => renderSidebarCameraRow(stream, false))}
        </ul>
      </>
    );
  };

  const renderFoundCameras = () => {
    const foundCount = sidebarDiscoveredCameraList.length;
    if (foundCount === 0 && !isDiscoveringCameras) {
      return null;
    }

    return (
      <div className="sidebar-found-cameras">
        <button
          type="button"
          className="sidebar-section-toggle sidebar-found-cameras-toggle"
          aria-expanded={foundCamerasExpanded}
          aria-controls="sidebar-found-cameras-panel"
          onClick={() => setFoundCamerasExpanded((expanded) => !expanded)}
          title="Cameras found on the network that are not added yet. Click one to add it."
        >
          <span className="sidebar-camera-status is-warning" aria-hidden="true"></span>
          <span className="sidebar-section-label">
            {isDiscoveringCameras && foundCount === 0 ? 'Scanning for cameras…' : 'Found cameras'}
          </span>
          {foundCount > 0 && <span className="sidebar-tree-count">{foundCount}</span>}
          <span className="sidebar-tree-toggle" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 6l6 6-6 6" />
            </svg>
          </span>
        </button>
        {foundCamerasExpanded && foundCount > 0 && (
          <ul
            id="sidebar-found-cameras-panel"
            className="sidebar-camera-tree sidebar-live-camera-list"
            aria-label="Found cameras"
          >
          {sidebarDiscoveredCameraList.map((device) => (
            <li
              key={`discovered-${device.ip_address}`}
              className={`sidebar-camera-node ${openMenu === `discovered:${device.ip_address}` ? 'is-menu-open' : ''}`}
            >
              <a
                href={`streams.html?discover=1&camera=${encodeURIComponent(device.ip_address)}`}
                className="sidebar-camera-link sidebar-network-camera-link"
                title={`${device.ip_address}${hasKnownModel(device) ? ` - ${[device.manufacturer, device.model].filter(isKnownValue).join(' ')}` : ''} - Found on the network. Click to add.`}
                onClick={(event) => openDiscoveredCameraInStreams(event, device)}
              >
                <span className="sidebar-camera-status is-warning" aria-hidden="true"></span>
                <TreeIcon type="camera" />
                <span className="sidebar-camera-name">{device.name || device.ip_address}</span>
                {hasKnownModel(device) && <span className="sidebar-camera-auth-badge">{device.model}</span>}
              </a>
              <div className="sidebar-layout-menu-wrap sidebar-camera-menu-wrap" onClick={(event) => event.stopPropagation()}>
                <button
                  type="button"
                  className="sidebar-kebab-button"
                  aria-label={`Open ${device.name || device.ip_address} menu`}
                  aria-haspopup="menu"
                  aria-expanded={openMenu === `discovered:${device.ip_address}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCameraContextMenu(null);
                    setOpenMenu((current) => (current === `discovered:${device.ip_address}` ? null : `discovered:${device.ip_address}`));
                  }}
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                    <circle cx="8" cy="3.25" r="1.2" />
                    <circle cx="8" cy="8" r="1.2" />
                    <circle cx="8" cy="12.75" r="1.2" />
                  </svg>
                </button>
                {openMenu === `discovered:${device.ip_address}` && (
                  <div className="sidebar-layout-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      className="is-danger"
                      onClick={() => {
                        setOpenMenu(null);
                        setDiscoveredDeviceToRemove(device);
                      }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
          </ul>
        )}
      </div>
    );
  };

  const renderCameraListSection = () => (
    <div className={`sidebar-camera-list-section ${cameraListCollapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-camera-list-heading">
        <button
          type="button"
          className="sidebar-section-heading sidebar-section-toggle"
          aria-expanded={!cameraListCollapsed}
          aria-controls="sidebar-camera-list-panel"
          onClick={() => setCameraListCollapsed((collapsed) => !collapsed)}
        >
          <span className="sidebar-section-label">Camera List</span>
          <span className="sidebar-tree-count">{sidebarCameraList.length}</span>
          <span className="sidebar-tree-toggle" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 6l6 6-6 6" />
            </svg>
          </span>
        </button>
        {canManageSidebarCameras && (
          <div className="sidebar-layout-menu-wrap" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="sidebar-kebab-button"
              aria-label="Open camera list menu"
              aria-haspopup="menu"
              aria-expanded={openMenu === 'camera-list'}
              onClick={(event) => {
                event.stopPropagation();
                setCameraContextMenu(null);
                setOpenMenu((current) => (current === 'camera-list' ? null : 'camera-list'));
              }}
            >
              <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <circle cx="8" cy="3.25" r="1.2" />
                <circle cx="8" cy="8" r="1.2" />
                <circle cx="8" cy="12.75" r="1.2" />
              </svg>
            </button>
            {openMenu === 'camera-list' && (
              <div className="sidebar-layout-menu" role="menu">
                <button type="button" role="menuitem" onClick={startCreateFolder}>Create folder</button>
              </div>
            )}
          </div>
        )}
      </div>
      {!cameraListCollapsed && (
        <div id="sidebar-camera-list-panel">
          {renderCameraList()}
          {renderFoundCameras()}
        </div>
      )}
    </div>
  );

  const renderCameraContextMenu = () => {
    if (!cameraContextMenu) return null;

    const cameraNames = selectedCameraNames.has(cameraContextMenu.cameraName) && selectedCameraNameList.length > 0
      ? selectedCameraNameList
      : [cameraContextMenu.cameraName];
    const canAddToCurrentWorkspace = activeNav === 'nav-live';
    const hasSavedLayouts = liveLayouts.layouts.length > 0;

    return (
      <div
        className="sidebar-camera-context-menu"
        role="menu"
        style={{ left: `${cameraContextMenu.x}px`, top: `${cameraContextMenu.y}px` }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="sidebar-camera-context-title">
          {cameraNames.length === 1 ? cameraNames[0] : `${cameraNames.length} cameras selected`}
        </div>
        <div className="sidebar-camera-context-group" aria-label="Add to layout">
          <div className="sidebar-camera-context-label">Add to layout</div>
          <button type="button" role="menuitem" onClick={handleCreateContextLayout}>
            New layout
          </button>
          {canAddToCurrentWorkspace && (
            <button type="button" role="menuitem" onClick={handleAddContextCamerasToWorkspace}>
              Blank layout
            </button>
          )}
          {hasSavedLayouts && liveLayouts.layouts.map((layout) => (
            <button
              type="button"
              role="menuitem"
              key={layout.id}
              onClick={() => handleAddContextCamerasToLayout(layout.id)}
            >
              {layout.name}
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderLayoutMenu = (layout) => {
    return (
      <div className="sidebar-layout-menu-wrap" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="sidebar-kebab-button"
          aria-label={layout ? `Open ${layout.name} layout menu` : 'Open layouts menu'}
          aria-expanded={openMenu === (layout ? `layout:${layout.id}` : 'layouts')}
          onClick={(event) => {
            event.stopPropagation();
            setOpenMenu((current) => {
              const key = layout ? `layout:${layout.id}` : 'layouts';
              return current === key ? null : key;
            });
          }}
        >
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <circle cx="8" cy="3.25" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="8" cy="12.75" r="1.2" />
          </svg>
        </button>
        {openMenu === (layout ? `layout:${layout.id}` : 'layouts') && (
          <div className="sidebar-layout-menu" role="menu">
            {layout ? (
              <>
                <button type="button" role="menuitem" onClick={() => startRenameLayout(layout)}>Rename</button>
                <button type="button" role="menuitem" onClick={() => deleteLayout(layout.id)}>Delete</button>
              </>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={startCreateLayout}
              >
                Create Layout
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const renderLayouts = () => (
    <div className="sidebar-layouts-section">
      <div className="sidebar-section-heading">
        <span className="sidebar-section-label">Layouts</span>
        {renderLayoutMenu(null)}
      </div>
      <a
        href={makeLiveHref({ layout: 'workspace' })}
        className={`sidebar-blank-layout-button ${activeNav === 'nav-live' && !liveSelection.layout && !liveSelection.stream ? 'is-active' : ''}`}
        onClick={(event) => navigateToAppPage(makeLiveHref({ layout: 'workspace' }), event)}
      >
        <TreeIcon type="area" />
        <span>Blank layout</span>
      </a>
      {creatingLayout && (
        <form className="sidebar-layout-inline-form" onSubmit={handleCreateLayout}>
          <input
            type="text"
            value={newLayoutName}
            autoFocus
            maxLength="96"
            placeholder="Layout name"
            onInput={(event) => setNewLayoutName(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setCreatingLayout(false);
                setNewLayoutName('');
              }
            }}
          />
          <button type="submit" disabled={!newLayoutName.trim()}>Save</button>
        </form>
      )}
      {liveLayouts.layouts.length === 0 && !creatingLayout ? (
        <div className="sidebar-building-empty">No layouts</div>
      ) : (
        <ul className="sidebar-layout-tree">
          {liveLayouts.layouts.map((layout) => {
            const expanded = expandedLayouts[layout.id] !== false;
            const layoutEditable = canEditSidebarLayout(layout.id);
            const isDropTarget = layoutEditable && dragOverLayoutId === layout.id;

            return (
              <li
                key={layout.id}
                className={`sidebar-layout-node ${isDropTarget ? 'is-drop-target' : ''}`}
                onDragOver={(event) => {
                  if (!layoutEditable) return;
                  const types = Array.from(event.dataTransfer.types || []);
                  if (!types.includes('application/x-oneberry-camera')) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                  setDragOverLayoutId(layout.id);
                }}
                onDragLeave={() => setDragOverLayoutId('')}
                onDrop={(event) => {
                  if (!layoutEditable) return;
                  const types = Array.from(event.dataTransfer.types || []);
                  if (!types.includes('application/x-oneberry-camera')) return;
                  event.preventDefault();
                  let cameraNames = [];
                  if (types.includes('application/x-oneberry-cameras')) {
                    try {
                      cameraNames = getCameraNameList(JSON.parse(event.dataTransfer.getData('application/x-oneberry-cameras')));
                    } catch (error) {
                      cameraNames = [];
                    }
                  }
                  const cameraName = event.dataTransfer.getData('application/x-oneberry-camera') || event.dataTransfer.getData('text/plain');
                  setDragOverLayoutId('');
                  addCamerasToLayout(layout.id, cameraNames.length > 0 ? cameraNames : [cameraName]);
                  setSelectedCameraNames(new Set());
                  cameraSelectionBeforeClickRef.current = new Set();
                  setCameraContextMenu(null);
                }}
              >
                <div className="sidebar-layout-row">
                  <button
                    type="button"
                    className="sidebar-tree-toggle"
                    onClick={() => toggleLayoutNode(layout.id)}
                    aria-label={expanded ? `Collapse ${layout.name}` : `Expand ${layout.name}`}
                    aria-expanded={expanded}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={expanded ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} />
                    </svg>
                  </button>
                  {renamingLayoutId === layout.id ? (
                    <form className="sidebar-layout-rename-form" onSubmit={handleRenameLayout}>
                      <input
                        type="text"
                        value={renameLayoutName}
                        autoFocus
                        maxLength="96"
                        onInput={(event) => setRenameLayoutName(event.currentTarget.value)}
                        onBlur={handleRenameLayout}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            setRenamingLayoutId('');
                            setRenameLayoutName('');
                          }
                        }}
                      />
                    </form>
                  ) : (
                    <a
                      href={makeLiveHref({ layout: layout.id })}
                      className={`sidebar-layout-title no-underline ${activeNav === 'nav-live' && liveSelection.layout === layout.id ? 'is-active' : ''}`}
                      title={layout.name}
                      aria-current={activeNav === 'nav-live' && liveSelection.layout === layout.id ? 'page' : undefined}
                      onClick={(event) => handleOpenLayout(layout.id, event)}
                    >
                      <TreeIcon type="area" />
                      <span className="sidebar-tree-label">{layout.name}</span>
                      <span className="sidebar-tree-count">{layout.tiles.length}</span>
                    </a>
                  )}
                  {renderLayoutMenu(layout)}
                </div>
                {expanded && (
                  <ul className="sidebar-layout-camera-tree">
                    {layout.tiles.map((tile, index) => {
                      const cameraName = tile.camera;
                      const stream = streamByName.get(cameraName);
                      const statusKind = stream ? getStreamStatusKind(stream) : 'offline';
                      const cameraHref = makeLiveHref({ layout: layout.id, camera: cameraName });
                      const cameraActive = activeNav === 'nav-live' && liveSelection.layout === layout.id && liveSelection.camera === cameraName;
                      return (
                        <li key={`${tile.id}-${index}`} className={`sidebar-layout-camera-node ${cameraActive ? 'is-active' : ''}`}>
                          <a
                            href={cameraHref}
                            className={`sidebar-camera-link sidebar-layout-camera-link ${cameraActive ? 'is-active' : ''}`}
                            title={`${cameraName}${stream ? ` - ${t(`sidebar.status.${statusKind}`)}` : ''}`}
                            aria-current={cameraActive ? 'page' : undefined}
                            onClick={(event) => handleOpenLayoutCamera(layout.id, cameraName, event)}
                          >
                            <span className={`sidebar-camera-status is-${statusKind}`} aria-hidden="true"></span>
                            <TreeIcon type="camera" />
                            <span className="sidebar-camera-name">{cameraName}</span>
                          </a>
                          {layoutEditable && (
                            <button
                              type="button"
                              className="sidebar-layout-camera-remove"
                              aria-label={`Remove ${cameraName} from ${layout.name}`}
                              title={`Remove ${cameraName}`}
                              onClick={() => removeCameraFromLayout(layout.id, tile)}
                            >
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" aria-hidden="true">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4l8 8M12 4l-8 8" />
                              </svg>
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  return (
      <>
      <header className={`app-header dashboard-sidebar ${mobileMenuOpen ? 'is-mobile-open' : ''} ${sidebarCollapsed ? 'is-collapsed' : ''} ${isDraggingSidebar ? 'is-resizing' : ''}`}>
        <div className="sidebar-brand-row">
          <div className="logo sidebar-brand">
            <span className="sidebar-brand-mark">O</span>
            <span className="sidebar-brand-copy">
              <h1>Oneberry</h1>
              <span className="version">v{version}</span>
            </span>
          </div>

          <button
              type="button"
              className="sidebar-collapse-toggle"
              onClick={toggleSidebarCollapsed}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-pressed={sidebarCollapsed}
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={sidebarCollapsed ? "M9 18l6-6-6-6" : "M15 18l-6-6 6-6"} />
            </svg>
          </button>

          <button
              className="mobile-menu-toggle"
              onClick={toggleMobileMenu}
              aria-label={t('nav.toggleMenu')}
              aria-expanded={mobileMenuOpen}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d={mobileMenuOpen ? "M6 18L18 6M6 6l12 12" : "M4 7h16M4 12h16M4 17h16"} />
            </svg>
          </button>
        </div>

        <div className="sidebar-content">
          <nav className="sidebar-main-nav" aria-label="Primary navigation">
            {renderCameraListSection()}
            {renderLayouts()}

            <div className="sidebar-section-label">Workspace</div>
            <ul>
              {navItems.map((navItem) => renderNavItem(navItem, true))}
            </ul>
          </nav>

          <div className="sidebar-account">
            <div className="sidebar-section-label">Account</div>
            <div className="sidebar-account-tools">
              <LanguageSelector mobile={true}/>
              {demoMode && !localStorage.getItem('auth') && (
                <span className="sidebar-demo-badge">{t('auth.demoMode')}</span>
              )}
            </div>
            <ul className="sidebar-user-actions">
              {renderUsername(true)}
              {isAdmin && renderCreateUserGroup(true)}
              {authEnabled && (
                demoMode && !localStorage.getItem('auth') ? renderLoginLogout(true, true) : renderLoginLogout(false, true)
              )}
            </ul>
          </div>
        </div>
        <div
          className="sidebar-resize-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize sidebar"
          title="Drag to resize. Drag left to collapse."
          onPointerDown={handleSidebarDragStart}
        />
      </header>
      {renderCameraContextMenu()}
      <ConfirmDialog
        isOpen={discoveredDeviceToRemove !== null}
        onClose={() => setDiscoveredDeviceToRemove(null)}
        onConfirm={() => removeDiscoveredDevice(discoveredDeviceToRemove)}
        title="Are you sure?"
        message={`Remove ${discoveredDeviceToRemove?.name || discoveredDeviceToRemove?.ip_address || ''} from the camera list? It will no longer be shown here, even after the next network scan.`}
        confirmLabel="Remove"
      />
      <ConfirmDialog
        isOpen={folderToDelete !== null}
        onClose={() => setFolderToDelete(null)}
        onConfirm={() => deleteFolder(folderToDelete)}
        title="Are you sure?"
        message={`Delete the folder "${folderToDelete?.name || ''}"?`}
        confirmLabel="Delete"
      />
      {folderPicker && createPortal(
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          data-keyboard-nav-preserve
          onClick={(event) => { if (event.target === event.currentTarget) setFolderPicker(null); }}
        >
          <div className="bg-card text-card-foreground rounded-lg shadow-xl p-6 max-w-md w-full mx-4" role="dialog" aria-modal="true" aria-labelledby="folder-picker-title">
            <h3 id="folder-picker-title" className="text-base font-semibold mb-1">
              Move cameras to "{cameraFolders.find((folder) => folder.id === folderPicker.folderId)?.name}"
            </h3>
            <p className="text-sm text-muted-foreground mb-4">
              Checked cameras are shown in this folder. A camera can only be in one folder.
            </p>
            <div className="max-h-72 overflow-y-auto border border-border rounded-md divide-y divide-border">
              {sidebarCameraList.length === 0 && (
                <div className="p-3 text-sm text-muted-foreground">No cameras</div>
              )}
              {sidebarCameraList.map((stream) => {
                const otherFolder = cameraFolders.find((folder) => (
                  folder.id !== folderPicker.folderId && (folder.cameras || []).includes(stream.name)
                ));
                const checked = folderPicker.selected.has(stream.name);
                return (
                  <label key={stream.name} className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover:bg-muted">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setFolderPicker((current) => {
                        const selected = new Set(current.selected);
                        if (selected.has(stream.name)) selected.delete(stream.name); else selected.add(stream.name);
                        return { ...current, selected };
                      })}
                    />
                    <span className="flex-1 truncate">{stream.name}</span>
                    {otherFolder && (
                      <span className="text-xs text-muted-foreground truncate">
                        {checked ? `moves from ${otherFolder.name}` : `in ${otherFolder.name}`}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
            <div className="flex justify-end gap-3 mt-5">
              <button
                type="button"
                className="px-4 py-2 border border-border rounded-md text-sm font-medium hover:bg-muted transition-colors"
                onClick={() => setFolderPicker(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                onClick={saveFolderCameraPicker}
              >
                Save
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {isProfileModalOpen && currentUser && (
        <EditUserModal
          currentUser={currentUser}
          formData={profileFormData}
          handleInputChange={handleProfileInputChange}
          handleEditUser={handleProfileSave}
          onClose={closeProfileModal}
          title={t('auth.editProfileTitle')}
          submitLabel={isSavingProfile ? t('common.saving') : t('common.saveChanges')}
          showPasswordField={true}
          showRoleField={false}
          showActiveField={false}
          showPasswordLockField={false}
          showAllowedTagsField={false}
          showAllowedLoginCidrsField={false}
          showClearLoginLockoutButton={false}
        />
      )}
      </>
  );
}
