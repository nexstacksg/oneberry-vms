/**
 * LightNVR Web Interface StreamsView Component
 * React component for the streams page
 */

import { Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { showStatusMessage } from './ToastContainer.jsx';
import { ContentLoader } from './LoadingIndicator.jsx';
import { StreamDeleteModal } from './StreamDeleteModal.jsx';
import { StreamBulkActionModal } from './StreamBulkActionModal.jsx';
import { StreamConfigModal } from './StreamConfigModal.jsx';
import { SubnetScanModal } from './SubnetScanModal.jsx';
import { HealthView } from './HealthView.jsx';
import { validateSession } from '../../utils/auth-utils.js';
import { obfuscateUrlCredentials, urlHasCredentials } from '../../utils/url-utils.js';
import { buildDiscoveredStreamPayload } from '../../utils/discovered-stream-utils.js';
import { detectedInfoToFormFields, formatDetectedSummary, isProbeableStreamUrl } from '../../utils/stream-probe-utils.js';
import {
  VIDEO_FPS_PRESETS,
  VIDEO_RESOLUTION_PRESETS,
  formatFpsValue,
  formatResolutionValue,
  parseFpsValue,
  parseResolutionValue
} from './videoOptions.js';
import {
  useQuery,
  useMutation,
  useQueryClient,
  usePostMutation,
  fetchJSON
} from '../../query-client.js';
import { useI18n } from '../../i18n.js';
import { useSortableData } from './useSortableData.js';

function buildStreamFormState(stream, motion, {
  name = stream.name || '',
  resetVideo = false,
  detectionZones = stream.detection_zones || [],
} = {}) {
  return {
    ...stream,
    name,
    // The saved name, so an edit can tell whether the camera is being renamed
    originalName: stream.name || '',
    width: resetVideo ? 0 : (stream.width || 0),
    height: resetVideo ? 0 : (stream.height || 0),
    fps: resetVideo ? 0 : (stream.fps || 0),
    codec: stream.codec || 'h264',
    protocol: (stream.protocol != null ? stream.protocol : 0).toString(),
    priority: (stream.priority != null ? stream.priority : 5).toString(),
    segment: stream.segment_duration || 60,
    detectionThreshold: stream.detection_threshold || 50,
    detectionInterval: stream.detection_interval || 10,
    preBuffer: stream.pre_detection_buffer || 10,
    detectionZones,
    postBuffer: stream.post_detection_buffer || 30,
    secondaryUrl: stream.secondary_url || '',
    adminUrl: stream.admin_url || '',
    streamingEnabled: stream.streaming_enabled !== undefined ? stream.streaming_enabled : true,
    isOnvif: stream.isOnvif !== undefined ? stream.isOnvif : false,
    onvifUsername: stream.onvif_username || '',
    onvifPassword: stream.onvif_password || '',
    onvifProfile: stream.onvif_profile || '',
    onvifPort: stream.onvif_port || 0,
    detectionEnabled: stream.detection_based_recording || false,
    detectionModel: stream.detection_model || '',
    recordAudio: stream.record_audio !== undefined ? stream.record_audio : true,
    backchannelEnabled: stream.backchannel_enabled !== undefined ? stream.backchannel_enabled : false,
    motionRecordingEnabled: motion ? !!motion.enabled : false,
    motionPreBuffer: motion ? (motion.pre_buffer_seconds || 5) : 5,
    motionPostBuffer: motion ? (motion.post_buffer_seconds || 10) : 10,
    motionMaxDuration: motion ? (motion.max_file_duration || 300) : 300,
    motionRetentionDays: motion ? (motion.retention_days || 7) : 7,
    motionCodec: motion ? (motion.codec || 'h264') : 'h264',
    motionQuality: motion ? (motion.quality || 'medium') : 'medium',
    ptzEnabled: stream.ptz_enabled !== undefined ? stream.ptz_enabled : false,
    ptzMaxX: stream.ptz_max_x || 0,
    ptzMaxY: stream.ptz_max_y || 0,
    ptzMaxZ: stream.ptz_max_z || 0,
    ptzHasHome: stream.ptz_has_home !== undefined ? stream.ptz_has_home : false,
    detectionObjectFilter: stream.detection_object_filter || 'none',
    detectionObjectFilterList: stream.detection_object_filter_list || '',
    retentionDays: stream.retention_days || 0,
    detectionRetentionDays: stream.detection_retention_days || 0,
    maxStorageMb: stream.max_storage_mb || 0,
    recordOnSchedule: stream.record_on_schedule || false,
    recordingSchedule: (Array.isArray(stream.recording_schedule) && stream.recording_schedule.length === 168)
      ? stream.recording_schedule
      : Array(168).fill(true),
    tags: stream.tags || '',
    motionTriggerSource: stream.motion_trigger_source || ''
  };
}

function getCredentialsFromStreamUrl(url) {
  const rawUrl = String(url || '').trim();
  if (!rawUrl) {
    return null;
  }

  try {
    const parsed = new URL(rawUrl);
    const username = parsed.username ? decodeURIComponent(parsed.username) : '';
    const password = parsed.password ? decodeURIComponent(parsed.password) : '';
    return username || password ? { username, password } : null;
  } catch {
    const match = rawUrl.match(/^[a-z][a-z0-9+.-]*:\/\/([^/@]+)@/i);
    if (!match) {
      return null;
    }

    const [username = '', password = ''] = match[1].split(':');
    try {
      return {
        username: decodeURIComponent(username),
        password: decodeURIComponent(password)
      };
    } catch {
      return { username, password };
    }
  }
}

function getDiscoveryProfileSortScore(profile) {
  if (!profile) {
    return 0;
  }

  const name = String(profile.name || '').toLowerCase();
  const width = Number(profile.width) || 0;
  const height = Number(profile.height) || 0;
  const fps = Number(profile.fps) || 0;
  const bitrate = Number(profile.bitrate) || 0;
  let score = (width * height) + (bitrate * 8) + (fps * 250);

  if (/(main|primary|high|stream[\s_-]*1|\b1\b)/.test(name)) {
    score += 100000000;
  }

  if (/(sub|secondary|low|stream[\s_-]*2|\b2\b)/.test(name)) {
    score -= 50000000;
  }

  return score;
}

function getDiscoveryProfileRole(profile, index) {
  const backendRole = String(profile?.stream_role || '').toLowerCase();
  if (backendRole === 'primary' || backendRole === 'secondary' || backendRole === 'additional') {
    return backendRole;
  }

  const name = String(profile?.name || '').toLowerCase();
  if (/(main|primary|high|stream[\s_-]*1|\b1\b)/.test(name)) {
    return 'primary';
  }
  if (/(sub|secondary|low|stream[\s_-]*2|\b2\b)/.test(name)) {
    return 'secondary';
  }

  if (index === 0) return 'primary';
  if (index === 1) return 'secondary';
  return 'additional';
}

function getDiscoveryProfileRoleLabel(role) {
  if (role === 'primary') return 'Primary stream';
  if (role === 'secondary') return 'Secondary stream';
  return 'Additional stream';
}

function getDiscoveryProfileStreamName(device, profile, role) {
  const deviceName = String(device?.name || device?.ip_address || 'camera').trim();
  const safeDeviceName = deviceName.replace(/\s+/g, '_');
  const profileName = String(profile?.name || 'stream').trim().replace(/\s+/g, '_');

  if (role === 'primary') {
    return `${safeDeviceName}_main`;
  }

  if (role === 'secondary') {
    return `${safeDeviceName}_sub`;
  }

  return `${safeDeviceName}_${profileName}`;
}

function buildDiscoveryPairName(device, primaryProfile, secondaryProfile) {
  const primaryName = getDiscoveryProfileStreamName(device, primaryProfile, 'primary');
  if (!secondaryProfile) {
    return primaryName;
  }

  return `${primaryName}_sub`;
}

const DISCOVERY_CAMERA_HANDOFF_KEY = 'oneberry.discoveryCameraHandoff';

function getDiscoveryDeviceKey(device) {
  return String(device?.ip_address || device?.device_service || device?.endpoint || device?.name || '').trim();
}

function mergeDiscoveredDevices(previousDevices, nextDevices) {
  const devicesByKey = new Map();

  (Array.isArray(previousDevices) ? previousDevices : []).forEach((device) => {
    const key = getDiscoveryDeviceKey(device);
    if (key) devicesByKey.set(key, device);
  });

  (Array.isArray(nextDevices) ? nextDevices : []).forEach((device) => {
    const key = getDiscoveryDeviceKey(device);
    if (key) devicesByKey.set(key, device);
  });

  return Array.from(devicesByKey.values())
    .sort((a, b) => String(a.ip_address || '').localeCompare(String(b.ip_address || '')));
}

function getStableDiscoveryDevices(previousDevices, data) {
  const nextDevices = Array.isArray(data?.devices) ? data.devices : [];
  const scanRunning = data?.running === true && data?.completed !== true;

  if (!scanRunning) {
    return nextDevices.length > 0
      ? nextDevices.slice().sort((a, b) => String(a.ip_address || '').localeCompare(String(b.ip_address || '')))
      : previousDevices;
  }

  if (nextDevices.length === 0) {
    return previousDevices;
  }

  return mergeDiscoveredDevices(previousDevices, nextDevices);
}

/**
 * StreamsView component
 * @returns {JSX.Element} StreamsView component
 */
export function StreamsView() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  // User role state for permission-based UI
  const [userRole, setUserRole] = useState(null);
  // Demo mode state - credentials should be hidden in demo mode
  const [isDemoMode, setIsDemoMode] = useState(false);

  // Fetch user role on mount
  useEffect(() => {
    const fetchUserRole = async () => {
      try {
        const result = await validateSession();
        if (result.valid && result.role) {
          setUserRole(result.role);
          setIsDemoMode(result.demo_mode === true);
        } else {
          // Session invalid - set to empty string to indicate fetch completed
          setUserRole('');
        }
      } catch (error) {
        console.error('Error fetching user role:', error);
        setUserRole('');
      }
    };
    fetchUserRole();
  }, []);

  // Role is still loading if null
  const roleLoading = userRole === null;
  // Check if user can modify streams (admin or user role, not viewer)
  // While loading, default to enabled so admin/user doesn't see hidden buttons
  const canModifyStreams = roleLoading || userRole === 'admin' || userRole === 'user';
  // Stream creation is restricted to administrators.
  const canCreateStreams = roleLoading || userRole === 'admin';
  // Check if credentials should be hidden (demo mode or viewer role)
  const shouldHideCredentials = isDemoMode || userRole === 'viewer';

  // State for streams data
  const [activeTab, setActiveTab] = useState('streams');
  const [streamsViewMode, setStreamsViewMode] = useState(() => {
    if (typeof window === 'undefined') return 'table';
    return localStorage.getItem('oneberry.streamsViewMode') === 'grid' ? 'grid' : 'table';
  });
  const [modalVisible, setModalVisible] = useState(false);
  const [subnetScanVisible, setSubnetScanVisible] = useState(false);
  const [onvifModalVisible, setOnvifModalVisible] = useState(false);
  const [showCustomNameInput, setShowCustomNameInput] = useState(false);
  const [isAddingStream, setIsAddingStream] = useState(false);
  const [discoveredDevices, setDiscoveredDevices] = useState([]);
  const [deviceProfiles, setDeviceProfiles] = useState([]);
  const [selectedDevice, setSelectedDevice] = useState(null);
  const [selectedProfile, setSelectedProfile] = useState(null);
  const [selectedSecondaryProfile, setSelectedSecondaryProfile] = useState(null);
  const [customStreamName, setCustomStreamName] = useState('');
  const [onvifCredentials, setOnvifCredentials] = useState({ username: '', password: '' });
  const [showDiscoveryPassword, setShowDiscoveryPassword] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [onvifNetworkOverride, setOnvifNetworkOverride] = useState('auto');
  const [onvifResolution, setOnvifResolution] = useState('');
  const [onvifFps, setOnvifFps] = useState('');

  // Track which stream rows are expanded to show health/status details
  const [expandedStreams, setExpandedStreams] = useState({});

  const toggleStreamExpand = (streamName) => {
    setExpandedStreams(prev => ({
      ...prev,
      [streamName]: !prev[streamName]
    }));
  };

  useEffect(() => {
    try {
      localStorage.setItem('oneberry.streamsViewMode', streamsViewMode);
    } catch {
      // Ignore storage failures in private or locked-down browser contexts.
    }
  }, [streamsViewMode]);

  // Track which stream URL credentials are currently revealed (by stream name).
  // By default every URL with credentials is masked, even for admins.
  const [revealedUrls, setRevealedUrls] = useState(new Set());

  const toggleUrlReveal = (streamName, e) => {
    e.stopPropagation();
    setRevealedUrls(prev => {
      const next = new Set(prev);
      next.has(streamName) ? next.delete(streamName) : next.add(streamName);
      return next;
    });
  };

  // Bulk selection state
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedStreams, setSelectedStreams] = useState(new Set());
  const [isBulkWorking, setIsBulkWorking] = useState(false);
  // null | 'disable' | 'delete' — which bulk confirmation modal is open
  const [bulkActionModal, setBulkActionModal] = useState(null);

  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedStreams(new Set());
  };

  const toggleSelect = (e, name) => {
    e.stopPropagation();
    setSelectedStreams(prev => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  };

  const toggleSelectAll = (e) => {
    e.stopPropagation();
    if (selectedStreams.size > 0) {
      setSelectedStreams(new Set());
    } else {
      setSelectedStreams(new Set((streams || []).map(s => s.name)));
    }
  };

  // Accordion expanded state for StreamConfigModal sections
  const [expandedSections, setExpandedSections] = useState({
    basic: true,
    recording: false,
    detection: false,
    zones: false,
    motion: false,
    ptz: false,
    advanced: false
  });

  const onvifResolutionOptions = [
    { value: '', label: t('streamsConfig.autoDetected') },
    ...(onvifResolution && !VIDEO_RESOLUTION_PRESETS.some(option =>
      formatResolutionValue(option.width, option.height) === onvifResolution
    )
      ? [{ value: onvifResolution, label: onvifResolution }]
      : []),
    ...VIDEO_RESOLUTION_PRESETS.map(option => ({
      value: formatResolutionValue(option.width, option.height),
      label: formatResolutionValue(option.width, option.height)
    }))
  ];

  const onvifFpsOptions = [
    { value: '', label: t('streamsConfig.autoDetected') },
    ...(onvifFps && !VIDEO_FPS_PRESETS.includes(Number(onvifFps))
      ? [{ value: onvifFps, label: `${onvifFps} fps` }]
      : []),
    ...VIDEO_FPS_PRESETS.map(fps => ({
      value: String(fps),
      label: `${fps} fps`
    }))
  ];

  const toggleSection = (section) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  // Fetch streams data
  const {
    data: streamsResponse = [],
    isLoading
  } = useQuery(['streams'], '/api/streams', {
    timeout: 10000,
    retries: 2,
    retryDelay: 1000
  });

  const {
    data: locationCatalog = { buildings: [] }
  } = useQuery(['locations'], '/api/locations', {
    timeout: 10000,
    retries: 1,
    retryDelay: 1000
  });

  // Fetch detection models
  const {
    data: detectionModelsData
  } = useQuery(['detectionModels'], '/api/detection/models', {
    timeout: 5000,
    retries: 1,
    retryDelay: 1000
  });

  // Sidebar camera folders (same cache key as the sidebar, so both stay in sync)
  const { data: cameraFoldersData } = useQuery(['camera-folders'], '/api/camera-folders', {
    timeout: 10000,
    retries: 1,
    retryDelay: 1000
  });
  const cameraFolders = Array.isArray(cameraFoldersData?.folders) ? cameraFoldersData.folders : [];

  // Put a newly created camera into the folder chosen in the Add Camera form
  const addCameraToFolder = async (cameraName, folderId) => {
    const folders = queryClient.getQueryData(['camera-folders'])?.folders || cameraFolders;
    if (!cameraName || !folders.some(folder => folder.id === folderId)) {
      return;
    }
    const nextFolders = folders.map(folder => ({
      ...folder,
      cameras: folder.id === folderId
        ? [...(folder.cameras || []).filter(name => name !== cameraName), cameraName]
        : (folder.cameras || []).filter(name => name !== cameraName),
    }));
    try {
      const saved = await fetchJSON('/api/camera-folders', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folders: nextFolders }),
        timeout: 10000,
        retries: 1,
        retryDelay: 1000
      });
      queryClient.setQueryData(['camera-folders'], saved);
    } catch (error) {
      showStatusMessage(`Camera added, but it could not be put in the folder: ${error.message}`, 'warning', 8000);
    }
  };

  // Process the response to handle both array and object formats
  const streams = Array.isArray(streamsResponse) ? streamsResponse : (streamsResponse.streams || []);

  const streamMatchesDiscoveredDevice = (stream, device) => {
    if (!stream || !device?.ip_address) {
      return false;
    }

    return [stream.url, stream.secondary_url].some((streamUrl) => {
      if (!streamUrl) return false;
      try {
        return new URL(streamUrl).hostname === device.ip_address;
      } catch {
        return String(streamUrl).includes(device.ip_address);
      }
    });
  };

  const getStoredCredentialsForDiscoveredDevice = (device) => {
    const existingStream = streams.find(stream => streamMatchesDiscoveredDevice(stream, device));
    if (!existingStream) {
      return null;
    }

    const onvifUsername = existingStream.onvif_username || existingStream.onvifUsername || '';
    const onvifPassword = existingStream.onvif_password || existingStream.onvifPassword || '';
    if (onvifUsername || onvifPassword) {
      return {
        username: onvifUsername,
        password: onvifPassword
      };
    }

    return getCredentialsFromStreamUrl(existingStream.url) ||
      getCredentialsFromStreamUrl(existingStream.secondary_url);
  };

  const selectDiscoveredDevice = (device) => {
    setSelectedDevice(device);
    setSelectedProfile(null);
    setSelectedSecondaryProfile(null);
    setDeviceProfiles([]);
    setShowCustomNameInput(false);

    const storedCredentials = getStoredCredentialsForDiscoveredDevice(device);
    if (storedCredentials) {
      setOnvifCredentials(storedCredentials);
    }
  };

  const DEFAULT_SORT_COLUMN = null;
  const {
    sortedItems: sortedStreams,
    sortColumn,
    sortDirection,
    handleSort,
  } = useSortableData(streams, DEFAULT_SORT_COLUMN, {
    name: (stream) => (stream.name || '').toLowerCase(),
    status: (stream) => (stream.status || '').toLowerCase(),
    url: (stream) => (stream.url || '').toLowerCase(),
    resolution: (stream) => (stream.width || 0) * (stream.height || 0),
    fps: (stream) => stream.fps || 0,
    recording: (stream) => stream.record ? 1 : 0,
  });

  // Default stream state
  const [currentStream, setCurrentStream] = useState({
    name: '',
    url: '',
    secondaryUrl: '',
    adminUrl: '',
    enabled: true,
    streamingEnabled: true,
    width: 1280,
    height: 720,
    fps: 15,
    codec: 'h264',
    protocol: '0',
    priority: '5',
    segment: 60,
    record: true,
    recordAudio: false,
    backchannelEnabled: false,
    // ONVIF capability flag
    isOnvif: false,
    // ONVIF credentials (for cameras that require authentication)
    onvifUsername: '',
    onvifPassword: '',
    onvifProfile: '',
    onvifPort: 0,
    // AI Detection recording
    detectionEnabled: false,
    detectionModel: '',
    detectionThreshold: 50,
    detectionInterval: 10,
    preBuffer: 10,
    postBuffer: 30,
    detectionZones: [],
    // Detection object filter defaults
    detectionObjectFilter: 'none',
    detectionObjectFilterList: '',
    // Motion (ONVIF) recording defaults
    motionRecordingEnabled: false,
    motionPreBuffer: 5,
    motionPostBuffer: 10,
    motionMaxDuration: 300,
    motionRetentionDays: 7,
    motionCodec: 'h264',
    motionQuality: 'medium',
    // PTZ control settings
    ptzEnabled: false,
    ptzMaxX: 0,
    ptzMaxY: 0,
    ptzMaxZ: 0,
    ptzHasHome: false,
    // Retention policy settings
    retentionDays: 1,
    detectionRetentionDays: 1,
    maxStorageMb: 0,
    // Recording schedule
    recordOnSchedule: false,
    recordingSchedule: Array(168).fill(true),
    // Tags
    tags: '',
    // Cross-stream motion trigger: name of another stream whose ONVIF motion
    // events trigger recording on this stream (e.g., PTZ slaved to fixed wide lens)
    motionTriggerSource: ''
  });
  const [isEditing, setIsEditing] = useState(false);
  // Result of the Test button next to the stream URL field
  const [urlProbe, setUrlProbe] = useState({ status: 'idle' });
  // Folder a newly added camera goes into ('' = none)
  const [newCameraFolderId, setNewCameraFolderId] = useState('');
  const probeAbortRef = useRef(null);
  const [isCloning, setIsCloning] = useState(false);

  // State for delete modal
  const [deleteModalVisible, setDeleteModalVisible] = useState(false);
  const [streamToDelete, setStreamToDelete] = useState(null);

  // Compute hasData from streams
  const hasData = streams && streams.length > 0;

  // Extract detection models from query result
  const detectionModels = detectionModelsData?.models || [];

  // Unified mutation that internally decides between create and update
  const saveStreamMutation = useMutation({
    mutationFn: async (streamData) => {
      const forcedMode = streamData?.__mode;
      const shouldUpdate = forcedMode === 'update' || (forcedMode !== 'create' && isEditing);
      const { __mode, originalName, ...payload } = streamData || {};

      if (shouldUpdate) {
        // A changed name is a rename: do it first, everywhere, then save the
        // remaining settings under the new name
        if (originalName && originalName !== payload.name) {
          await fetchJSON(`/api/streams/${encodeURIComponent(originalName)}/rename`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: payload.name }),
            timeout: 30000,
            retries: 0
          });
        }
        // Update existing stream via PUT
        const url = `/api/streams/${encodeURIComponent(payload.name)}`;
        // `name` is used as the stream identifier in the URL path and must not be included in the request body
        const { name, ...rest } = payload;
        return await fetchJSON(url, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(rest),
          timeout: 15000,
          retries: 1,
          retryDelay: 1000
        });
      }
      if (!canCreateStreams) {
        throw new Error(t('streams.createStreamForbidden'));
      }
      // Create new stream via POST
      return await fetchJSON('/api/streams', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        timeout: 45000,
        retries: 1,
        retryDelay: 1000
      });
    },
    onSuccess: (data, variables) => {
      const forcedMode = variables?.__mode;
      const didUpdate = forcedMode === 'update' || (forcedMode !== 'create' && isEditing);
      if (didUpdate) {
        showStatusMessage(
          t('streams.streamUpdatedSuccessfully', { name: variables?.name }),
          'success',
          3000
        );
      } else {
        showStatusMessage(t('streams.streamAddedSuccessfully'));
        if (data?.warning_message) {
          showStatusMessage(data.warning_message, 'warning', 9000);
        }
        if (newCameraFolderId) {
          addCameraToFolder(variables?.name, newCameraFolderId);
        }
      }
      closeModal();
      // Invalidate and refetch streams data (and what refers to cameras by name)
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      if (didUpdate && variables?.originalName && variables.originalName !== variables.name) {
        queryClient.invalidateQueries({ queryKey: ['camera-folders'] });
        queryClient.invalidateQueries({ queryKey: ['live-layouts'] });
      }
    },
    onError: (error, variables) => {
      const forcedMode = variables?.__mode;
      const didUpdate = forcedMode === 'update' || (forcedMode !== 'create' && isEditing);
      if (!didUpdate) {
        showStatusMessage(
          t('streams.errorAddingStream', { message: error.message }),
          'error',
          5000
        );
      } else {
        showStatusMessage(
          t('streams.errorUpdatingStream', { message: error.message }),
          'error',
          5000
        );
      }
    }
  });

  // Mutation for deleting stream
  const deleteStreamMutation = useMutation({
    mutationFn: async (params) => {
      const { streamId } = params;
      const url = `/api/streams/${encodeURIComponent(streamId)}?permanent=true`;
      return await fetchJSON(url, {
        method: 'DELETE',
        timeout: 15000,
        retries: 1,
        retryDelay: 1000
      });
    },
    onSuccess: () => {
      showStatusMessage(t('streams.streamSuccessfullyDeleted'));
      // Invalidate and refetch streams data
      queryClient.invalidateQueries({ queryKey: ['streams'] })
        .then(() => {
          // Close the modal after the query invalidation is complete
          closeDeleteModal();
        });
    },
    onError: (error) => {
      showStatusMessage(t('streams.errorDeletingStream', { message: error.message }), 'error', 5000);
      closeDeleteModal();
    }
  });

  const disableStreamMutation = useMutation({
    mutationFn: async (params) => {
      const { streamId } = params;
      const url = `/api/streams/${encodeURIComponent(streamId)}`;
      return await fetchJSON(url, {
        method: 'DELETE',
        timeout: 15000,
        retries: 1,
        retryDelay: 1000
      });
    },
    onSuccess: () => {
      showStatusMessage(t('streams.streamSuccessfullyDisabled'));
      // Invalidate and refetch streams data
      queryClient.invalidateQueries({ queryKey: ['streams'] })
        .then(() => {
          // Close the modal after the query invalidation is complete
          closeDeleteModal();
        });
    },
    onError: (error) => {
      showStatusMessage(t('streams.errorDisablingStream', { message: error.message }), 'error', 5000);
      closeDeleteModal();
    }
  });

  const enableStreamMutation = useMutation({
    mutationFn: async (streamId) => {
      return await fetchJSON(`/api/streams/${encodeURIComponent(streamId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enable_disabled: true, enabled: true }),
        timeout: 15000,
        retries: 1,
        retryDelay: 1000
      });
    },
    onSuccess: () => {
      showStatusMessage(t('streams.streamSuccessfullyEnabled') || 'Stream enabled.');
      queryClient.invalidateQueries({ queryKey: ['streams'] });
    },
    onError: (error) => {
      showStatusMessage(t('streams.errorEnablingStream', { message: error.message }) || `Error enabling stream: ${error.message}`, 'error', 5000);
    }
  });

  const handleToggleStreamEnabled = (stream) => {
    if (stream.enabled) {
      if (window.confirm(t('live.disableStreamConfirm'))) {
        disableStreamMutation.mutate({ streamId: stream.name });
      }
    } else {
      enableStreamMutation.mutate(stream.name);
    }
  };

  // Bulk action handlers — open the confirmation modal instead of using alert()
  const handleBulkEnable = () => {
    if (selectedStreams.size === 0 || isBulkWorking) return;
    setBulkActionModal('enable');
  };

  const handleBulkDisable = () => {
    if (selectedStreams.size === 0 || isBulkWorking) return;
    setBulkActionModal('disable');
  };

  const handleBulkDelete = () => {
    if (selectedStreams.size === 0 || isBulkWorking) return;
    setBulkActionModal('delete');
  };

  // Execute bulk enable after modal confirmation
  const executeBulkEnable = async () => {
    const names = [...selectedStreams];
    setIsBulkWorking(true);
    const results = await Promise.allSettled(
      names.map(name =>
        fetchJSON(`/api/streams/${encodeURIComponent(name)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          // Both enable_disabled:true and enabled:true are required so the worker
          // thread writes enabled=1 to the DB; without enabled:true the worker
          // overwrites the direct SQL enable with the stale enabled=0 from the
          // config struct.
          body: JSON.stringify({ enable_disabled: true, enabled: true }),
          timeout: 15000,
        })
      )
    );
    setIsBulkWorking(false);
    setBulkActionModal(null);
    setSelectedStreams(new Set());
    queryClient.invalidateQueries({ queryKey: ['streams'] });
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      showStatusMessage(t('streams.enabledSomeStreams', { success: names.length - failed, failed }), 'warning', 5000);
    } else {
      showStatusMessage(t('streams.enabledStreams', { count: names.length }), 'success');
    }
  };

  // Execute bulk disable after modal confirmation
  const executeBulkDisable = async () => {
    const names = [...selectedStreams];
    setIsBulkWorking(true);
    const results = await Promise.allSettled(
      names.map(name =>
        fetchJSON(`/api/streams/${encodeURIComponent(name)}`, { method: 'DELETE', timeout: 15000 })
      )
    );
    setIsBulkWorking(false);
    setBulkActionModal(null);
    setSelectedStreams(new Set());
    queryClient.invalidateQueries({ queryKey: ['streams'] });
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      showStatusMessage(t('streams.disabledSomeStreams', { success: names.length - failed, failed }), 'warning', 5000);
    } else {
      showStatusMessage(t('streams.disabledStreams', { count: names.length }), 'success');
    }
  };

  // Execute bulk delete after modal confirmation
  const executeBulkDelete = async () => {
    const names = [...selectedStreams];
    setIsBulkWorking(true);
    const results = await Promise.allSettled(
      names.map(name =>
        fetchJSON(`/api/streams/${encodeURIComponent(name)}?permanent=true`, { method: 'DELETE', timeout: 15000 })
      )
    );
    setIsBulkWorking(false);
    setBulkActionModal(null);
    setSelectedStreams(new Set());
    queryClient.invalidateQueries({ queryKey: ['streams'] });
    const failed = results.filter(r => r.status === 'rejected').length;
    if (failed > 0) {
      showStatusMessage(t('streams.deletedSomeStreams', { success: names.length - failed, failed }), 'warning', 5000);
    } else {
      showStatusMessage(t('streams.deletedStreams', { count: names.length }), 'success');
    }
  };

  const normalizeRecordingSchedule = (recordingSchedule, recordOnSchedule) => {
    if (!recordOnSchedule) {
      return Array(168).fill(true);
    }
    if (Array.isArray(recordingSchedule) && recordingSchedule.length === 168) {
      return recordingSchedule;
    }
    return Array(168).fill(true);
  };

  // Handle form submission
  const handleSubmit = (e) => {
    e.preventDefault();

    // Prepare stream data for API
    const streamData = {
      name: currentStream.name.trim(),
      originalName: isEditing ? currentStream.originalName : undefined,
      url: currentStream.url,
      secondary_url: currentStream.secondaryUrl || '',
      admin_url: currentStream.adminUrl || '',
      enabled: currentStream.enabled,
      streaming_enabled: currentStream.streamingEnabled,
      width: parseInt(currentStream.width, 10) || 0,
      height: parseInt(currentStream.height, 10) || 0,
      fps: parseInt(currentStream.fps, 10) || 0,
      codec: currentStream.codec || 'h264',
      protocol: parseInt(currentStream.protocol, 10),
      priority: parseInt(currentStream.priority, 10),
      segment_duration: parseInt(currentStream.segment, 10),
      record: currentStream.record,
      detection_based_recording: currentStream.detectionEnabled,
      detection_model: currentStream.detectionModel,
      // Persist ONVIF flag expected by backend (camelCase key)
      isOnvif: !!currentStream.isOnvif,
      // ONVIF credentials (for motion detection, PTZ, etc.)
      onvif_username: currentStream.onvifUsername || '',
      onvif_password: currentStream.onvifPassword || '',
      onvif_profile: currentStream.onvifProfile || '',
      onvif_port: parseInt(currentStream.onvifPort, 10) || 0,
      detection_threshold: parseInt(currentStream.detectionThreshold, 10),
      detection_interval: parseInt(currentStream.detectionInterval, 10),
      pre_detection_buffer: parseInt(currentStream.preBuffer, 10),
      post_detection_buffer: parseInt(currentStream.postBuffer, 10),
      record_audio: currentStream.recordAudio,
      backchannel_enabled: currentStream.backchannelEnabled,
      // PTZ control settings
      ptz_enabled: !!currentStream.ptzEnabled,
      ptz_max_x: parseInt(currentStream.ptzMaxX, 10) || 0,
      ptz_max_y: parseInt(currentStream.ptzMaxY, 10) || 0,
      ptz_max_z: parseInt(currentStream.ptzMaxZ, 10) || 0,
      ptz_has_home: !!currentStream.ptzHasHome,
      // Detection object filter settings
      detection_object_filter: currentStream.detectionObjectFilter || 'none',
      detection_object_filter_list: currentStream.detectionObjectFilterList || '',
      // Retention policy settings
      retention_days: parseInt(currentStream.retentionDays, 10) || 0,
      detection_retention_days: parseInt(currentStream.detectionRetentionDays, 10) || 0,
      max_storage_mb: parseInt(currentStream.maxStorageMb, 10) || 0,
      // Recording schedule
      record_on_schedule: !!currentStream.recordOnSchedule,
      recording_schedule: normalizeRecordingSchedule(
        currentStream.recordingSchedule,
        currentStream.recordOnSchedule
      ),
      // Tags
      tags: currentStream.tags || '',
      // Cross-stream motion trigger source
      motion_trigger_source: currentStream.motionTriggerSource || ''
    };

    // When editing, set is_deleted to false to allow undeleting soft-deleted streams
    if (isEditing) {
      streamData.is_deleted = false;
    }

    // Use mutation to save stream and then handle motion config if applicable
    const savedStreamName = streamData.name;
    saveStreamMutation.mutate(streamData, {
      onSuccess: async () => {
        try {
          if (currentStream.isOnvif) {
            const motionUrl = `/api/motion/config/${encodeURIComponent(currentStream.name)}`;
            if (currentStream.motionRecordingEnabled) {
              const body = {
                enabled: true,
                pre_buffer_seconds: parseInt(currentStream.motionPreBuffer, 10),
                post_buffer_seconds: parseInt(currentStream.motionPostBuffer, 10),
                max_file_duration: parseInt(currentStream.motionMaxDuration, 10),
                codec: currentStream.motionCodec,
                quality: currentStream.motionQuality,
                retention_days: parseInt(currentStream.motionRetentionDays, 10)
              };
              await fetchJSON(motionUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                timeout: 15000
              });
            } else {
              // Delete motion config if disabling
              await fetchJSON(motionUrl, {
                method: 'DELETE',
                timeout: 15000
              });
            }
          }
        } catch (err) {
          showStatusMessage(t('streams.motionConfigSaveFailed', { message: err.message }), 'error', 5000);
        }
        // Ensure both list and details are refreshed after save
        await queryClient.invalidateQueries({ queryKey: ['stream-full', savedStreamName] });
        queryClient.invalidateQueries({ queryKey: ['streams'] });
        // Close the modal after successful save
        closeModal();
      }
    });
  };

  // What identifies one test: the URL plus anything that changes how it connects.
  // A result is only shown while these still match, so editing the URL clears it.
  const getStreamProbeKey = (stream) => JSON.stringify([
    (stream?.url || '').trim(),
    String(stream?.protocol),
    stream?.isOnvif ? stream.onvifUsername || '' : '',
    stream?.isOnvif ? stream.onvifPassword || '' : '',
  ]);

  const resetUrlProbe = () => {
    probeAbortRef.current?.abort();
    probeAbortRef.current = null;
    setUrlProbe({ status: 'idle' });
  };

  // Test button next to the stream URL: probe the stream and, if it can be
  // read, fill in resolution, fps and codec from what the camera sends.
  const testStreamUrl = async () => {
    const url = (currentStream.url || '').trim();
    const key = getStreamProbeKey(currentStream);

    if (!isProbeableStreamUrl(url)) {
      setUrlProbe({
        status: 'failed',
        key,
        message: 'Enter a complete RTSP URL, for example rtsp://user:password@192.168.1.10:554/stream',
      });
      return;
    }

    probeAbortRef.current?.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    setUrlProbe({ status: 'detecting', key });

    try {
      const data = await fetchJSON('/api/streams/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          protocol: parseInt(currentStream.protocol, 10),
          onvif_username: currentStream.isOnvif ? currentStream.onvifUsername : undefined,
          onvif_password: currentStream.isOnvif ? currentStream.onvifPassword : undefined,
        }),
        signal: controller.signal,
        timeout: 20000,
        retries: 0,
      });
      if (controller.signal.aborted) {
        return;
      }
      if (data?.success && data.info) {
        const fields = detectedInfoToFormFields(data.info);
        if (Object.keys(fields).length > 0) {
          setCurrentStream(prev => ({ ...prev, ...fields }));
        }
        setUrlProbe({ status: 'detected', key, summary: formatDetectedSummary(fields) });
      } else {
        setUrlProbe({ status: 'failed', key, message: data?.message || 'Could not read the stream' });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setUrlProbe({ status: 'failed', key, message: error.message });
      }
    } finally {
      if (probeAbortRef.current === controller) {
        probeAbortRef.current = null;
      }
    }
  };

  const visibleUrlProbe = urlProbe.status !== 'idle' && urlProbe.key === getStreamProbeKey(currentStream)
    ? urlProbe
    : { status: 'idle' };

  // Trigger a simulated ONVIF motion event for the current stream
  const triggerTestMotionEvent = async () => {
    if (!currentStream?.name) {
      showStatusMessage(t('streams.setStreamNameAndSaveBeforeTestingMotion'), 'error', 5000);
      return;
    }
    if (!currentStream?.isOnvif) {
      showStatusMessage(t('streams.enableOnvifCameraFirst'), 'error', 5000);
      return;
    }
    try {
      // Ensure the server has motion recording enabled with current UI settings
      if (currentStream.motionRecordingEnabled) {
        const motionUrl = `/api/motion/config/${encodeURIComponent(currentStream.name)}`;
        const body = {
          enabled: true,
          pre_buffer_seconds: parseInt(currentStream.motionPreBuffer, 10),
          post_buffer_seconds: parseInt(currentStream.motionPostBuffer, 10),
          max_file_duration: parseInt(currentStream.motionMaxDuration, 10),
          codec: currentStream.motionCodec,
          quality: currentStream.motionQuality,
          retention_days: parseInt(currentStream.motionRetentionDays, 10)
        };
        await fetchJSON(motionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeout: 10000
        });
      }

      // Now fire the test motion event
      const data = await fetchJSON(`/api/motion/test/${encodeURIComponent(currentStream.name)}`, {
        method: 'POST',
        timeout: 15000
      });
      if (data?.success) {
        showStatusMessage(t('streams.testMotionEventTriggeredSuccessfully'), 'success', 3000);
      } else {
        showStatusMessage(t('streams.testMotionEventFailed', { message: data?.message || t('common.unknown') }), 'error', 5000);
      }
    } catch (err) {
      showStatusMessage(t('streams.errorTriggeringTestMotion', { message: err.message }), 'error', 5000);
    }
  };


  // Open delete modal
  const openDeleteModal = (stream) => {
    setStreamToDelete(stream);
    setDeleteModalVisible(true);
  };

  // Close delete modal
  const closeDeleteModal = () => {
    setDeleteModalVisible(false);
    setStreamToDelete(null);
  };

  // Open add stream modal
  const openAddStreamModal = () => {
    if (!canCreateStreams) {
      showStatusMessage(t('streams.createStreamForbidden'), 'error', 5000);
      return;
    }
    setCurrentStream({
      name: '',
      url: '',
      secondaryUrl: '',
      adminUrl: '',
      enabled: true,
      streamingEnabled: true,
      width: 0,
      height: 0,
      fps: 0,
      codec: 'h264',
      protocol: '0',
      priority: '5',
      segment: 60,
      record: true,
      recordAudio: false,
      backchannelEnabled: false,
      isOnvif: false,
      onvifUsername: '',
      onvifPassword: '',
      onvifProfile: '',
      onvifPort: 0,
      detectionEnabled: false,
      detectionModel: '',
      detectionThreshold: 50,
      detectionInterval: 10,
      preBuffer: 10,
      postBuffer: 30,
      detectionObjectFilter: 'none',
      detectionObjectFilterList: '',
      motionRecordingEnabled: false,
      motionPreBuffer: 5,
      motionPostBuffer: 10,
      motionMaxDuration: 300,
      motionRetentionDays: 7,
      motionCodec: 'h264',
      motionQuality: 'medium',
      ptzEnabled: false,
      ptzMaxX: 0,
      ptzMaxY: 0,
      ptzMaxZ: 0,
      ptzHasHome: false,
      retentionDays: 1,
      detectionRetentionDays: 1,
      maxStorageMb: 0,
      // Recording schedule
      recordOnSchedule: false,
      recordingSchedule: Array(168).fill(true),
      // Tags
      tags: ''
    });
    resetUrlProbe();
    setNewCameraFolderId('');
    setIsEditing(false);
    setIsCloning(false);
    setModalVisible(true);
  };

  // Open edit stream modal
  const openEditStreamModal = async (streamId) => {
    try {
      // Use queryClient to fetch stream details (force fresh)
      const data = await queryClient.fetchQuery({
        queryKey: ['stream-full', streamId],
        queryFn: async () => {
          const response = await fetch(`/api/streams/${encodeURIComponent(streamId)}/full`);
          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
          }
          return response.json();
        },
        staleTime: 0 // Always fetch fresh when opening modal
      });
      const stream = data.stream || {};
      const motion = data.motion_config || null;

      setCurrentStream(buildStreamFormState(stream, motion));
      resetUrlProbe();
      setIsEditing(true);
      setModalVisible(true);
    } catch (error) {
      console.error('Error loading stream details:', error);
      showStatusMessage(t('streams.errorLoadingStreamDetails', { message: error.message }));
    }
  };

  // Open clone stream modal — pre-fills from an existing stream but treats as a new one
  const openCloneStreamModal = async (streamId) => {
    if (!canCreateStreams) {
      showStatusMessage(t('streams.createStreamForbidden'), 'error', 5000);
      return;
    }
    try {
      await queryClient.invalidateQueries({ queryKey: ['stream-full', streamId] });
      const data = await queryClient.fetchQuery({
        queryKey: ['stream-full', streamId],
        queryFn: async () => {
          const response = await fetch(`/api/streams/${encodeURIComponent(streamId)}/full`);
          if (!response.ok) {
            throw new Error(`HTTP error ${response.status}`);
          }
          return response.json();
        },
        staleTime: 0
      });
      const stream = data.stream || {};
      const motion = data.motion_config || null;

      setCurrentStream(buildStreamFormState(stream, motion, {
        name: `${t('streams.copyOf')} ${stream.name || streamId}`,
        resetVideo: true,
        detectionZones: [],
      }));
      resetUrlProbe();
      setIsEditing(false);
      setIsCloning(true);
      setModalVisible(true);
    } catch (error) {
      console.error('Error loading stream details for clone:', error);
      showStatusMessage(t('streams.errorLoadingStreamDetails', { message: error.message }));
    }
  };

  // Close modal
  const closeModal = () => {
    resetUrlProbe();
    setNewCameraFolderId('');
    setModalVisible(false);
    setIsEditing(false);
    setIsCloning(false);
  };

  // Open ONVIF discovery modal
  const openOnvifModal = async (initialDevice = null) => {
    if (!canCreateStreams) {
      showStatusMessage(t('streams.createStreamForbidden'), 'error', 5000);
      return;
    }
    setDeviceProfiles([]);
    setSelectedDevice(initialDevice);
    if (initialDevice?.ip_address) {
      setDiscoveredDevices((previousDevices) => mergeDiscoveredDevices(previousDevices, [initialDevice]));
    }
    setSelectedProfile(null);
    setSelectedSecondaryProfile(null);
    setCustomStreamName('');
    setOnvifCredentials({ username: '', password: '' });
    setShowDiscoveryPassword(false);
    setShowCustomNameInput(false);
    setOnvifResolution('');
    setOnvifFps('');
    setIsEditing(false);
    setIsCloning(false);
    let discoveryNetwork = 'auto';
    // Fetch the configured default network from settings
    try {
      const settings = await fetchJSON('/api/settings', { timeout: 5000 });
      if (settings && settings.onvif_discovery_network) {
        discoveryNetwork = settings.onvif_discovery_network;
      } else {
        discoveryNetwork = 'auto';
      }
    } catch (e) {
      console.warn('Could not fetch ONVIF discovery network setting, using auto', e);
      discoveryNetwork = 'auto';
    }
    setOnvifNetworkOverride(discoveryNetwork);
    setOnvifModalVisible(true);
    try {
      const data = await fetchJSON('/api/discovery/cameras/status', {
        timeout: 5000,
        retries: 0
      });
      const statusDevices = Array.isArray(data.devices) ? data.devices : [];
      setDiscoveredDevices((previousDevices) => getStableDiscoveryDevices(previousDevices, data));
      setIsDiscovering(data.running === true && !data.completed);
      if (initialDevice?.ip_address) {
        const matchedDevice = statusDevices.find(device => device.ip_address === initialDevice.ip_address) || initialDevice;
        setSelectedDevice(matchedDevice);
      }
    } catch (error) {
      console.warn('Unable to load existing camera discovery status:', error);
    }
    onvifDiscoveryMutation.mutate({
      network: discoveryNetwork,
      include_onvif: true,
      include_rtsp: false
    });
  };

  // Handle form input change
  const handleInputChange = (e) => {
    const { name, value, type, checked } = e.target;

    // Special handling for detection model changes
    if (name === 'detectionModel') {
      if (value === 'custom-api') {
        // When switching to custom API, initialize with empty URL
        setCurrentStream(prev => ({
          ...prev,
          detectionModel: ''
        }));
        return;
      }

      if (value === 'motion') {
        // Built-in motion is a direct frame-difference detector, not an AI
        // model. Give it a motion-friendly default sensitivity instead of the
        // generic AI threshold so users get immediate motion-triggered clips.
        setCurrentStream(prev => ({
          ...prev,
          detectionModel: value,
          detectionThreshold:
            Number.isFinite(Number(prev.detectionThreshold)) && Number(prev.detectionThreshold) !== 50
              ? prev.detectionThreshold
              : 15
        }));
        return;
      }
    }

    // Special handling for custom API URL input
    if (name === 'customApiUrl') {
      setCurrentStream(prev => ({
        ...prev,
        detectionModel: value
      }));
      return;
    }

    setCurrentStream(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? checked : value
    }));
  };

  // Disable stream (soft delete)
  const disableStream = (streamId) => {
    disableStreamMutation.mutate({
      streamId,
    });
  };

  // Delete stream (permanent)
  const deleteStream = (streamId) => {
    deleteStreamMutation.mutate({
      streamId,
    });
  };

  // Handle ONVIF credential input change
  const handleCredentialChange = (e) => {
    const { name, value } = e.target;
    setOnvifCredentials(prev => ({
      ...prev,
      [name]: value
    }));
  };

  // Handle threshold change
  const handleThresholdChange = (e) => {
    const value = e.target.value;
    setCurrentStream(prev => ({
      ...prev,
      detectionThreshold: value
    }));
  };

  // Load detection models
  const loadDetectionModels = () => {
    queryClient.invalidateQueries({ queryKey: ['detectionModels'] });
  };

  // Universal ONVIF + RTSP discovery mutation
  const onvifDiscoveryMutation = usePostMutation(
    '/api/discovery/cameras',
    {
      timeout: 15000,
      retries: 0
    },
    {
      onMutate: () => {
        setIsDiscovering(true);
        setSelectedProfile(null);
        setSelectedSecondaryProfile(null);
        setDeviceProfiles([]);
        setShowCustomNameInput(false);
      },
      onSuccess: (data) => {
        setDiscoveredDevices((previousDevices) => getStableDiscoveryDevices(previousDevices, data));
        setIsDiscovering(data.running === true && !data.completed);
      },
      onError: (error) => {
        showStatusMessage(t('streams.errorDiscoveringOnvifDevices', { message: error.message }), 'error', 5000);
        setIsDiscovering(false);
      }
    }
  );

  useEffect(() => {
    if (!onvifModalVisible || !isDiscovering) {
      return undefined;
    }

    let cancelled = false;
    const pollDiscoveryStatus = async () => {
      try {
        const data = await fetchJSON('/api/discovery/cameras/status', {
          timeout: 5000,
          retries: 0
        });
        if (cancelled) {
          return;
        }
        setDiscoveredDevices((previousDevices) => getStableDiscoveryDevices(previousDevices, data));
        if (data.error) {
          showStatusMessage(t('streams.errorDiscoveringOnvifDevices', { message: data.error }), 'error', 5000);
          setIsDiscovering(false);
          return;
        }
        if (!data.running || data.completed) {
          setIsDiscovering(false);
        }
      } catch (error) {
        if (!cancelled) {
          console.warn('Unable to poll camera discovery status:', error);
        }
      }
    };

    pollDiscoveryStatus();
    const intervalId = window.setInterval(pollDiscoveryStatus, 800);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [onvifModalVisible, isDiscovering, t]);

  useEffect(() => {
    if (typeof window === 'undefined' || !canCreateStreams) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    if (params.get('discover') !== '1') {
      return;
    }

    let handoffDevice = null;
    try {
      const rawHandoff = sessionStorage.getItem(DISCOVERY_CAMERA_HANDOFF_KEY);
      if (rawHandoff) {
        const parsed = JSON.parse(rawHandoff);
        if (parsed?.device?.ip_address) {
          handoffDevice = parsed.device;
        }
      }
      sessionStorage.removeItem(DISCOVERY_CAMERA_HANDOFF_KEY);
    } catch (error) {
      // Ignore malformed or unavailable session storage.
    }

    const cameraIp = params.get('camera') || handoffDevice?.ip_address || '';
    const initialDevice = handoffDevice || (cameraIp ? {
      ip_address: cameraIp,
      name: cameraIp,
      rtsp: true,
      onvif: false,
      rtsp_ports: [],
      manufacturer: 'Unknown',
      model: 'Unknown',
      status: 'RTSP Found'
    } : null);

    openOnvifModal(initialDevice);

    params.delete('discover');
    params.delete('camera');
    const nextSearch = params.toString();
    const nextUrl = `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', nextUrl);
  }, [canCreateStreams]);

  // Edit / Delete requested from the sidebar camera menu via
  // streams.html?edit=<name> or ?delete=<name>. The SPA keeps this view
  // mounted when navigating within it, so also re-check on oneberry:navigate.
  const [sidebarActionTick, setSidebarActionTick] = useState(0);
  useEffect(() => {
    const onNavigate = () => setSidebarActionTick(tick => tick + 1);
    window.addEventListener('oneberry:navigate', onNavigate);
    return () => window.removeEventListener('oneberry:navigate', onNavigate);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || roleLoading || isLoading) {
      return;
    }

    const params = new URLSearchParams(window.location.search);
    const editName = params.get('edit');
    const deleteName = params.get('delete');
    const addToFolder = params.get('add') === '1' ? (params.get('folder') || '') : null;
    if (!editName && !deleteName && addToFolder === null) {
      return;
    }

    params.delete('edit');
    params.delete('delete');
    params.delete('add');
    params.delete('folder');
    const nextSearch = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash || ''}`);

    if (addToFolder !== null) {
      // openAddStreamModal checks permission and resets the folder, so set it after
      openAddStreamModal();
      if (canCreateStreams) {
        setNewCameraFolderId(addToFolder);
      }
      return;
    }

    if (!canModifyStreams) {
      showStatusMessage('You do not have permission to edit or delete cameras.', 'error', 5000);
      return;
    }

    const targetName = editName || deleteName;
    const stream = streams.find(s => s.name === targetName);
    if (!stream) {
      showStatusMessage(`Camera "${targetName}" was not found`, 'error', 5000);
      return;
    }

    if (editName) {
      openEditStreamModal(stream.name);
    } else {
      openDeleteModal(stream);
    }
  }, [roleLoading, isLoading, canModifyStreams, canCreateStreams, streamsResponse, sidebarActionTick]);

  const validateRtspDeviceMutation = usePostMutation(
    '/api/discovery/rtsp/validate',
    {
      timeout: 60000,
      retries: 0
    },
    {
      onMutate: () => {
        setIsLoadingProfiles(true);
      },
      onSuccess: (data, variables) => {
        setIsLoadingProfiles(false);
        const validatedDevice = variables?.device || selectedDevice;
        if (data.success && validatedDevice) {
          const info = data.info || {};
          const rtspProfiles = Array.isArray(data.profiles) && data.profiles.length > 0
            ? data.profiles.map((profile, index) => ({
                token: profile.token || `rtsp-${validatedDevice.ip_address}-${index}`,
                name: profile.name || (index === 0 ? 'RTSP Main Stream' : 'RTSP Sub Stream'),
                stream_uri: profile.stream_uri || profile.url || data.url,
                width: profile.width || 0,
                height: profile.height || 0,
                encoding: profile.encoding || profile.codec || 'unknown',
                fps: profile.fps || 0,
                stream_role: profile.stream_role || (index === 0 ? 'primary' : 'secondary'),
                isRtsp: true
              }))
            : [{
                token: `rtsp-${validatedDevice.ip_address}`,
                name: 'RTSP Main Stream',
                stream_uri: data.url,
                width: info.width || 0,
                height: info.height || 0,
                encoding: info.codec || 'unknown',
                fps: info.fps || 0,
                stream_role: 'primary',
                isRtsp: true
              }];
          const primaryProfile = rtspProfiles.find(profile => getDiscoveryProfileRole(profile, 0) === 'primary') || rtspProfiles[0];
          setDeviceProfiles(rtspProfiles);
          setSelectedProfile(primaryProfile);
          setSelectedSecondaryProfile(null);
          showStatusMessage(t('streams.connectionSuccessful'), 'success', 3000);
        } else {
          showStatusMessage(
            data.message || t('streams.connectionFailed', { message: 'No common RTSP stream opened successfully' }),
            'error',
            5000
          );
        }
      },
      onError: (error) => {
        setIsLoadingProfiles(false);
        showStatusMessage(t('streams.errorTestingConnection', { message: error.message }), 'error', 5000);
      }
    }
  );

  const validateRtspDiscoveredDevice = (device) => {
    if (!device?.rtsp) {
      return false;
    }

    const ports = Array.isArray(device.rtsp_ports) ? device.rtsp_ports : [];

    validateRtspDeviceMutation.mutate({
      device,
      ip_address: device.ip_address,
      port: ports[0] || 554,
      ports,
      manufacturer: device.manufacturer || '',
      model: device.model || '',
      username: onvifCredentials.username,
      password: onvifCredentials.password
    });
    return true;
  };

  /**
   * Validate that an ONVIF device host address is a well-formed hostname, IPv4
   * address, or bracketed IPv6 address. Returns true when valid, false otherwise.
   */
  const isValidDeviceHost = (deviceHost) => {
    if (typeof deviceHost !== 'string') {
      return false;
    }
    // Validate the discovered IP/host before constructing fallback URLs to avoid malformed URLs.
    // Allow typical hostnames / IPv4-like hosts and optional IPv6 literal in brackets, but reject
    // malformed inputs such as consecutive dots or invalid IPv6 sequences.
    const hostnamePattern =
      /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?))*$/;
    // IPv4 addresses (e.g. 192.168.1.100) — hostnamePattern allows alphanumeric labels but
    // the look-ahead length check can reject short dotted-decimal addresses, so validate them
    // explicitly with a dedicated pattern.
    const ipv4Pattern =
      /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
    // IPv6 literal in brackets. This pattern supports full and compressed IPv6 forms,
    // e.g. "[2001:db8::1]", "[::1]", and "[::]".
    const ipv6BracketPattern =
      /^\[((?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4})|(?:(?:[0-9A-Fa-f]{1,4}:){1,7}:)|(?:::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4})|(?:(?:[0-9A-Fa-f]{1,4}:){1,6}:[0-9A-Fa-f]{1,4})|(?:::[0-9A-Fa-f]{1,4})|(?:[0-9A-Fa-f]{1,4}::))\]$/;
    return (
      hostnamePattern.test(deviceHost) ||
      ipv4Pattern.test(deviceHost) ||
      ipv6BracketPattern.test(deviceHost)
    );
  };

  // Get device profiles mutation
  const getDeviceProfilesMutation = useMutation({
    mutationFn: ({ device, credentials }) => {
      setIsLoadingProfiles(true);

      // Use device_service URL which includes the correct port and scheme from discovery
      // Fall back to constructing URL from ip_address if device_service is not available.
      // When constructing the URL, prefer HTTPS and only fall back to HTTP if necessary.
      const discoveredUrl = device.device_service;
      const ipAddress = device.ip_address;

      const isValidHost = isValidDeviceHost(ipAddress);
      if (!isValidHost) {
        throw new Error('Invalid device IP address');
      }

      const buildDeviceServiceUrl = (scheme, host) => {
        try {
          const url = new URL(`${scheme}://${host}/onvif/device_service`);
          return url.toString();
        } catch (e) {
          throw new Error('Invalid device URL');
        }
      };

      const httpsFallbackUrl = buildDeviceServiceUrl('https', ipAddress);
      const httpFallbackUrl = buildDeviceServiceUrl('http', ipAddress);

      const attemptFetch = (deviceUrl) => {
        return fetch('/api/onvif/device/profiles', {
          method: 'GET',
          headers: {
            'X-Device-URL': deviceUrl,
            'X-Username': credentials.username,
            'X-Password': credentials.password,
            'X-Device-Manufacturer': device.manufacturer || '',
            'X-Device-Model': device.model || ''
          }
        }).then(async response => {
          if (!response.ok) {
            // The server explains camera-side failures (e.g. ONVIF login rejected) in {"error": "..."}
            const body = await response.json().catch(() => null);
            const error = new Error(body?.error || `HTTP error ${response.status}`);
            error.status = response.status;
            throw error;
          }
          return response.json();
        });
      };

      if (discoveredUrl) {
        // If discovery provided a full URL (including scheme), use it as-is.
        return attemptFetch(discoveredUrl);
      }
      // In security-sensitive environments, set this to true (or wire it to configuration)
      // to disable falling back from HTTPS to HTTP for device profile discovery.
      const DISABLE_HTTP_FALLBACK =
        typeof window !== 'undefined' &&
        window.LIGHTNVR_CONFIG &&
        typeof window.LIGHTNVR_CONFIG.disableOnvifHttpFallback === 'boolean'
          ? window.LIGHTNVR_CONFIG.disableOnvifHttpFallback
          : false;
      // Try HTTPS first; if that fails, optionally fall back to HTTP.
      return attemptFetch(httpsFallbackUrl).catch((error) => {
        if (DISABLE_HTTP_FALLBACK) {
          // In strict mode, propagate the original error without attempting insecure HTTP.
          throw error;
        }
        showStatusMessage(
          t('streams.warningFallingBackToHttp', 'HTTPS connection failed; retrying over HTTP. Credentials may be sent in plain text.'),
          'warning',
          5000
        );
        return attemptFetch(httpFallbackUrl);
      });
    },
    onSuccess: (data, variables) => {
      const profiles = data.profiles || [];
      if (profiles.length === 0 &&
          variables?.device?.rtsp &&
          validateRtspDiscoveredDevice(variables.device)) {
        return;
      }

      setDeviceProfiles(profiles);
      setIsLoadingProfiles(false);
    },
    onError: (error, variables) => {
      if (variables?.device?.rtsp &&
          validateRtspDiscoveredDevice(variables.device)) {
        return;
      }

      showStatusMessage(t('streams.errorLoadingDeviceProfiles', { message: error.message }), 'error', 12000);
      setIsLoadingProfiles(false);
    }
  });

  // Test ONVIF connection mutation
  const testOnvifConnectionMutation = usePostMutation(
    '/api/onvif/device/test',
    {
      timeout: 15000,
      retries: 0
    },
    {
      onMutate: () => {
        setIsLoadingProfiles(true);
      },
      onSuccess: (data, variables) => {
        if (data.success) {
          showStatusMessage(t('streams.connectionSuccessful'), 'success', 3000);
          const testedDevice = variables?.device || selectedDevice;
          if (testedDevice) {
            getDeviceProfiles(testedDevice);
          }
        } else {
          if (variables?.fallbackToRtsp && validateRtspDiscoveredDevice(variables.device)) {
            return;
          }
          showStatusMessage(t('streams.connectionFailed', { message: data.message }), 'error', 5000);
          setIsLoadingProfiles(false);
        }
      },
      onError: (error, variables) => {
        if (variables?.fallbackToRtsp && validateRtspDiscoveredDevice(variables.device)) {
          return;
        }
        showStatusMessage(t('streams.errorTestingConnection', { message: error.message }), 'error', 5000);
        setIsLoadingProfiles(false);
      }
    }
  );



  // Submit ONVIF device
  const submitOnvifDevice = () => {
    if (!selectedDevice || !selectedProfile || !customStreamName.trim()) {
      showStatusMessage(t('streams.missingRequiredInformation'), 'error', 5000);
      return;
    }

    setIsAddingStream(true);
    const { width, height } = parseResolutionValue(onvifResolution);
    const fps = parseFpsValue(onvifFps);
    const isOnvifProfile = !selectedProfile.isRtsp;
    const streamData = buildDiscoveredStreamPayload({
      name: customStreamName,
      streamUrl: selectedProfile.stream_uri,
      secondaryUrl: selectedSecondaryProfile?.stream_uri || '',
      username: onvifCredentials.username,
      password: onvifCredentials.password,
      isOnvif: isOnvifProfile,
      onvifProfile: selectedProfile.token || selectedProfile.name || '',
      width,
      height,
      fps,
    });

    // Use mutation to save stream
    saveStreamMutation.mutate({ ...streamData, __mode: 'create' }, {
      onSuccess: () => {
        setIsAddingStream(false);
        setShowCustomNameInput(false);
        setOnvifModalVisible(false);
        setSelectedProfile(null);
        setSelectedSecondaryProfile(null);
        setSelectedDevice(null);
        setCustomStreamName('');
        setOnvifResolution('');
        setOnvifFps('');
      },
      onError: () => {
        setIsAddingStream(false);
      },
    });
  };

  // Get ONVIF device profiles
  const getDeviceProfiles = (device) => {
    setSelectedDevice(device);
    setDeviceProfiles([]);
    setSelectedProfile(null);
    setSelectedSecondaryProfile(null);
    getDeviceProfilesMutation.mutate({
      device,
      credentials: onvifCredentials
    });
  };

  const openSelectedDiscoveryStream = () => {
    if (!selectedDevice || !selectedProfile) {
      showStatusMessage(t('streams.missingRequiredInformation'), 'error', 5000);
      return;
    }

    setCustomStreamName(buildDiscoveryPairName(selectedDevice, selectedProfile, selectedSecondaryProfile));
    setOnvifResolution(formatResolutionValue(selectedProfile.width, selectedProfile.height));
    setOnvifFps(formatFpsValue(selectedProfile.fps));
    setShowCustomNameInput(true);
  };

  // Select ONVIF device profile for the new stream
  const addOnvifDeviceAsStream = (profile, role = 'additional') => {
    const normalizedProfile = { ...profile, isOnvif: true };
    if (role === 'secondary') {
      setSelectedSecondaryProfile(normalizedProfile);
      return;
    }

    setSelectedProfile(normalizedProfile);
    if (selectedSecondaryProfile?.token === normalizedProfile.token) {
      setSelectedSecondaryProfile(null);
    }
  };

  const addRtspDeviceAsStream = (profile, role = 'additional') => {
    if (role === 'secondary') {
      setSelectedSecondaryProfile(profile);
      return;
    }

    setSelectedProfile(profile);
    if (selectedSecondaryProfile?.token === profile.token) {
      setSelectedSecondaryProfile(null);
    }
  };

  // Check if a discovered ONVIF device is already added as a stream
  const isDeviceAlreadyAdded = (device) => {
    return streams.some(stream => streamMatchesDiscoveredDevice(stream, device));
  };

  /**
   * Build the ONVIF device_service URL for a discovered device.
   * Returns a string URL on success, or null if the address is invalid
   * (and shows an appropriate status message).
   */
  const buildOnvifDeviceUrl = (device) => {
    let deviceUrl = device && device.device_service;
    if (!deviceUrl) {
      if (!device || !device.ip_address) {
        showStatusMessage(
          t('streams.onvifInvalidAddress') || 'ONVIF device IP address is missing or invalid.',
          'error'
        );
        return null;
      }
      try {
        // Construct a well-formed URL using the browser URL parser
        const urlObj = new URL(
          '/onvif/device_service',
          'http://' + String(device.ip_address).trim()
        );
        deviceUrl = urlObj.toString();
      } catch (e) {
        showStatusMessage(
          t('streams.onvifInvalidAddress') || 'ONVIF device IP address is missing or invalid.',
          'error'
        );
        return null;
      }
    }
    return deviceUrl;
  };

  // Test ONVIF connection
  const testOnvifConnection = (device) => {
    // Store the selected device first
    setSelectedDevice(device);
    setDeviceProfiles([]);
    setSelectedProfile(null);
    setSelectedSecondaryProfile(null);

    if (device.rtsp && !device.onvif) {
      validateRtspDiscoveredDevice(device);
      return;
    }

    // Build the device_service URL (using discovery data or ip_address fallback)
    const deviceUrl = buildOnvifDeviceUrl(device);
    if (!deviceUrl) {
      return;
    }
    const isInsecure = typeof deviceUrl === 'string' && deviceUrl.startsWith('http://');

    // Then make the API call
    testOnvifConnectionMutation.mutate({
      url: deviceUrl,
      username: onvifCredentials.username,
      password: onvifCredentials.password,
      insecure: isInsecure,
      device,
      fallbackToRtsp: !!device.rtsp
    });
  };

  const getDiscoveryDeviceType = (device) => {
    if (device?.onvif && device?.rtsp) return 'ONVIF + RTSP';
    if (device?.onvif) return 'ONVIF';
    return 'RTSP';
  };

  const getDiscoveryStatusClass = (device) => {
    const status = String(device?.status || '').toLowerCase();
    if (status.includes('valid')) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    if (status.includes('rtsp')) return 'bg-blue-50 text-blue-700 border-blue-200';
    if (status.includes('discover')) return 'bg-green-50 text-green-700 border-green-200';
    return 'bg-muted text-muted-foreground border-border';
  };

  const rankedDeviceProfiles = [...deviceProfiles].sort((a, b) => getDiscoveryProfileSortScore(b) - getDiscoveryProfileSortScore(a));
  const selectedDeviceAlreadyAdded = selectedDevice ? isDeviceAlreadyAdded(selectedDevice) : false;
  const renderDiscoveredProfileCard = (profile, index, variant = 'default') => {
    if (!profile) {
      return null;
    }

    const role = getDiscoveryProfileRole(profile, index);
    const roleLabel = getDiscoveryProfileRoleLabel(role);
    const isRtsp = !!profile.isRtsp;
    const isPrimaryVariant = variant === 'primary';
    const isSecondaryVariant = variant === 'secondary';
    const isPrimarySelected = selectedProfile?.token === profile.token;
    const isSecondarySelected = selectedSecondaryProfile?.token === profile.token;

    return (
      <div
        key={profile.token || `${profile.name || 'profile'}-${index}`}
        className={`rounded-md border p-3 ${
          isPrimaryVariant
            ? 'border-emerald-200 bg-emerald-50/40'
            : isSecondaryVariant
              ? 'border-blue-200 bg-blue-50/40'
              : 'border-border bg-background'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <div className="font-medium text-sm">{profile.name}</div>
              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${
                role === 'primary'
                  ? 'border-emerald-200 bg-emerald-100 text-emerald-700'
                  : role === 'secondary'
                    ? 'border-blue-200 bg-blue-100 text-blue-700'
                    : 'border-border bg-muted text-muted-foreground'
              }`}>
                {roleLabel}
              </span>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {profile.width || 0}x{profile.height || 0} · {profile.encoding || t('common.unknown')} · {profile.fps || 0} {t('streams.fps')}
            </div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            className={isPrimarySelected ? 'btn-secondary focus:outline-none focus:ring-2 focus:ring-primary' : 'btn-primary focus:outline-none focus:ring-2 focus:ring-primary'}
            onClick={() => (isRtsp ? addRtspDeviceAsStream(profile, 'primary') : addOnvifDeviceAsStream(profile, 'primary'))}
            type="button"
            disabled={isSecondarySelected}
          >
            {isPrimarySelected ? 'Primary selected' : 'Use as primary'}
          </button>
          <button
            className={isSecondarySelected ? 'btn-secondary focus:outline-none focus:ring-2 focus:ring-primary' : 'btn-primary focus:outline-none focus:ring-2 focus:ring-primary'}
            onClick={() => (isRtsp ? addRtspDeviceAsStream(profile, 'secondary') : addOnvifDeviceAsStream(profile, 'secondary'))}
            type="button"
            disabled={isPrimarySelected}
          >
            {isSecondarySelected ? 'Secondary selected' : 'Use as secondary'}
          </button>
        </div>
      </div>
    );
  };

  const getStreamStatusMeta = (stream) => {
    const statusColor =
      stream.status === 'Running'      ? 'hsl(var(--success))' :
      stream.status === 'Starting'     ? 'hsl(var(--warning, 45 93% 47%))' :
      stream.status === 'Reconnecting' ? 'hsl(var(--warning, 45 93% 47%))' :
      stream.status === 'Error'        ? 'hsl(var(--danger))' :
      stream.status === 'Stopping'     ? 'hsl(var(--warning, 45 93% 47%))' :
      stream.status === 'Stopped'      ? 'hsl(var(--danger))' :
      'hsl(var(--muted-foreground))';
    const statusLabel =
      stream.status === 'Running'      ? t('streams.running')      :
      stream.status === 'Starting'     ? t('streams.starting')     :
      stream.status === 'Reconnecting' ? t('streams.reconnecting') :
      stream.status === 'Error'        ? t('streams.error')        :
      stream.status === 'Stopping'     ? t('streams.stopping')     :
      stream.status === 'Stopped'      ? t('streams.stopped')      :
      (stream.status || t('common.unknown'));

    return { statusColor, statusLabel };
  };

  const getRecordingSummary = (stream) => {
    if (!stream.record && !stream.detection_based_recording) {
      return t('common.disabled');
    }

    const parts = [];
    if (stream.record) {
      parts.push(stream.record_on_schedule ? t('streams.schedule') : t('streams.continuous'));
    }
    if (stream.detection_based_recording) {
      parts.push(t('streams.detection'));
    }
    return parts.join(' + ') || t('common.enabled');
  };

  const renderUrlValue = (stream, maxWidthClass = 'max-w-xs') => (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        className={`min-w-0 truncate font-mono text-xs ${maxWidthClass}`}
        title={revealedUrls.has(stream.name) ? stream.url : obfuscateUrlCredentials(stream.url)}
      >
        {revealedUrls.has(stream.name) ? stream.url : obfuscateUrlCredentials(stream.url)}
      </span>
      {urlHasCredentials(stream.url) && !shouldHideCredentials && (
        <button
          type="button"
          className="flex-shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus:outline-none"
          onClick={(e) => toggleUrlReveal(stream.name, e)}
          title={revealedUrls.has(stream.name) ? t('streams.hideCredentials') : t('streams.showCredentials')}
        >
          {revealedUrls.has(stream.name) ? (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 4.411m0 0L21 21" />
            </svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
      )}
    </div>
  );

  const renderStreamActions = (stream, className = 'flex space-x-2') => {
    const hasAdminLauncher = !shouldHideCredentials && /^https?:\/\//i.test(stream.admin_url || '');

    return (
      <div className={className}>
        {hasAdminLauncher && (
          <a
            className="rounded-full p-1 focus:outline-none"
            style={{color: 'hsl(var(--primary))'}}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--primary) / 0.1)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            href={stream.admin_url}
            target="_blank"
            rel="noopener noreferrer"
            title={t('streams.openCameraAdminPage')}
            aria-label={t('streams.openAdminPageFor', { name: stream.name })}
            onClick={(e) => e.stopPropagation()}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 3h7m0 0v7m0-7L10 14"></path>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 5h5M5 5v14h14v-5"></path>
            </svg>
          </a>
        )}
        {canModifyStreams && (
          <button
            className="rounded-full p-1 focus:outline-none"
            style={{color: 'hsl(var(--primary))'}}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--primary) / 0.1)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={(e) => { e.stopPropagation(); openEditStreamModal(stream.name); }}
            title={t('common.edit')}
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
              <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"></path>
            </svg>
          </button>
        )}
        {canCreateStreams && (
          <button
            className="rounded-full p-1 focus:outline-none"
            style={{color: 'hsl(var(--success))'}}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--success) / 0.1)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={(e) => { e.stopPropagation(); openCloneStreamModal(stream.name); }}
            title={t('streams.cloneStream')}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>
        )}
        {canModifyStreams && (
          <button
            className="rounded-full p-1 focus:outline-none"
            style={{color: stream.enabled ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))'}}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = stream.enabled ? 'hsl(var(--success) / 0.1)' : 'hsl(var(--muted-foreground) / 0.1)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={(e) => { e.stopPropagation(); handleToggleStreamEnabled(stream); }}
            title={stream.enabled ? t('streams.toggleDisable') : t('streams.toggleEnable')}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </button>
        )}
        {canModifyStreams && (
          <button
            className="rounded-full p-1 focus:outline-none"
            style={{color: 'hsl(var(--danger))'}}
            onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--danger) / 0.1)'}
            onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
            onClick={(e) => { e.stopPropagation(); openDeleteModal(stream); }}
            title={t('common.delete')}
          >
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
              <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"></path>
            </svg>
          </button>
        )}
        {!canModifyStreams && !hasAdminLauncher && (
          <span className="text-muted-foreground">-</span>
        )}
      </div>
    );
  };

  const renderStreamDetailChips = (stream) => (
    <div className="grid gap-2 text-sm sm:grid-cols-2">
      <div className="rounded-md bg-muted/35 px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('common.enabled')}</div>
        <div className="mt-1 font-medium" style={{color: stream.enabled ? 'hsl(var(--success))' : 'hsl(var(--danger))'}}>
          {stream.enabled ? t('common.yes') : t('common.no')}
        </div>
      </div>
      <div className="rounded-md bg-muted/35 px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('streams.streaming')}</div>
        <div className="mt-1 font-medium" style={{color: stream.streaming_enabled ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))'}}>
          {stream.streaming_enabled ? t('common.active') : t('streams.off')}
        </div>
      </div>
      <div className="rounded-md bg-muted/35 px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('streams.codec')}</div>
        <div className="mt-1 font-medium">{stream.codec || t('streams.notAvailable')}</div>
      </div>
      <div className="rounded-md bg-muted/35 px-3 py-2">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('streams.priority')}</div>
        <div className="mt-1 font-medium">{stream.priority || t('streams.notAvailable')}</div>
      </div>
      {stream.record && (
        <div className="rounded-md bg-muted/35 px-3 py-2 sm:col-span-2">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('streams.segment')}</div>
          <div className="mt-1 font-medium">
            {stream.segment_duration
              ? (stream.segment_duration >= 60 ? `${Math.round(stream.segment_duration / 60)}min` : `${stream.segment_duration}s`)
              : t('streams.notAvailable')}
          </div>
        </div>
      )}
    </div>
  );

  const renderStreamGridCard = (stream) => {
    const isExpanded = expandedStreams[stream.name];
    const { statusColor, statusLabel } = getStreamStatusMeta(stream);
    const tags = String(stream.tags || '').split(',').map(tag => tag.trim()).filter(Boolean);

    return (
      <article
        key={stream.name}
        className={`rounded-lg border bg-card p-4 shadow-sm transition-all hover:border-primary/30 hover:shadow-md ${
          selectedStreams.has(stream.name) ? 'border-primary ring-2 ring-primary/20' : 'border-border'
        }`}
        onClick={() => toggleStreamExpand(stream.name)}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              {canModifyStreams && selectionMode && (
                <input
                  type="checkbox"
                  className="h-4 w-4 flex-shrink-0 rounded cursor-pointer"
                  checked={selectedStreams.has(stream.name)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => toggleSelect(event, stream.name)}
                />
              )}
              <span
                className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
                style={{backgroundColor: stream.enabled ? 'hsl(var(--success))' : 'hsl(var(--danger))'}}
                title={stream.enabled ? t('common.enabled') : t('common.disabled')}
              />
              <h3 className="min-w-0 truncate text-base font-semibold text-foreground" title={stream.name}>{stream.name}</h3>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium text-white"
                style={{backgroundColor: statusColor, opacity: stream.enabled ? 1 : 0.6}}
              >
                {statusLabel}
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-muted/35 px-2 py-0.5 text-xs text-muted-foreground">
                {stream.width || 0}x{stream.height || 0}
              </span>
              <span className="inline-flex items-center rounded-full border border-border bg-muted/35 px-2 py-0.5 text-xs text-muted-foreground">
                {stream.fps || 0} {t('streams.fps')}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={isExpanded ? 'Collapse stream details' : 'Expand stream details'}
            onClick={(event) => {
              event.stopPropagation();
              toggleStreamExpand(stream.name);
            }}
          >
            <svg
              className={`h-4 w-4 transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('common.url')}</div>
            <div onClick={(event) => event.stopPropagation()}>
              {renderUrlValue(stream, 'max-w-full')}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('streams.recording')}</div>
              <div className="mt-1 text-sm font-medium">{getRecordingSummary(stream)}</div>
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t('streams.detection')}</div>
              <div className="mt-1 text-sm font-medium">
                {stream.detection_based_recording
                  ? (stream.detection_model ? stream.detection_model.split('/').pop() : t('common.enabled'))
                  : t('streams.off')}
              </div>
            </div>
          </div>
          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tags.slice(0, 4).map(tag => (
                <span key={tag} className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                  {tag}
                </span>
              ))}
              {tags.length > 4 && (
                <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
                  +{tags.length - 4}
                </span>
              )}
            </div>
          )}
        </div>

        {isExpanded && (
          <div className="mt-4 border-t border-border pt-4">
            {renderStreamDetailChips(stream)}
          </div>
        )}

        <div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">{isExpanded ? 'Details open' : 'Click for details'}</span>
          {renderStreamActions(stream, 'flex items-center gap-1')}
        </div>
      </article>
    );
  };

  return (
    <section id="streams-page" className="page">
      <div className="page-header flex justify-between items-center mb-4 p-4 bg-card text-card-foreground rounded-lg shadow">
        <h2 className="text-xl font-bold">{t('nav.streams')}</h2>
        <div className="controls flex items-center space-x-2">
          {!canModifyStreams && userRole && (
            <span className="text-sm text-muted-foreground italic mr-2">
              {t('streams.readOnlyInsufficientPermissions')}
            </span>
          )}
          {canModifyStreams && !canCreateStreams && userRole === 'user' && (
            <span className="text-sm text-muted-foreground italic mr-2">
              {t('streams.createStreamRestricted')}
            </span>
          )}
          {canModifyStreams && (
            <>
              {!selectionMode && (
                <button
                  className="flex items-center gap-1.5 text-sm px-2 py-1 rounded hover:bg-muted/70 transition-colors text-muted-foreground focus:outline-none"
                  onClick={() => setSelectionMode(true)}
                  title={t('streams.enterSelectionMode')}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                  </svg>
                  {t('streams.select')}
                </button>
              )}
              {canCreateStreams && (
                <>
                  <button
                      id="discover-onvif-btn"
                      className="btn-secondary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                      onClick={openOnvifModal}
                      title={t('streams.discoverNetworkCamerasTitle')}
                  >
                    {t('streams.discoverNetworkCameras')}
                  </button>
                  <button
                      id="subnet-scan-open-btn"
                      className="btn-secondary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                      onClick={() => setSubnetScanVisible(true)}
                      title="Scan an IP range for ONVIF and RTSP cameras"
                  >
                    Subnet Scan
                  </button>
                  <button
                      id="add-stream-btn"
                      className="btn-primary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
                      onClick={openAddStreamModal}
                      title={t('streams.addCameraManuallyTitle')}
                  >
                    {t('streams.addCameraManually')}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <div className="mb-4 border-b border-border" role="tablist" aria-label={t('nav.streams')}>
        <div className="flex gap-2">
          <button
            type="button"
            id="streams-tab"
            role="tab"
            aria-selected={activeTab === 'streams'}
            aria-controls="streams-panel"
            className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'streams'
                ? 'bg-card text-card-foreground border border-border border-b-0 -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('streams')}
          >
            {t('nav.streams')}
          </button>
          <button
            type="button"
            id="health-tab"
            role="tab"
            aria-selected={activeTab === 'health'}
            aria-controls="health-panel"
            className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === 'health'
                ? 'bg-card text-card-foreground border border-border border-b-0 -mb-px'
                : 'text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => setActiveTab('health')}
          >
            {t('nav.health')}
          </button>
        </div>
      </div>

      {activeTab === 'health' ? (
        <div role="tabpanel" id="health-panel" aria-labelledby="health-tab">
          <HealthView />
        </div>
      ) : (
        <div role="tabpanel" id="streams-panel" aria-labelledby="streams-tab">
          <ContentLoader
              isLoading={isLoading}
              hasData={hasData}
              loadingMessage={t('streams.loadingStreams')}
              emptyMessage={canModifyStreams ? t('streams.noStreamsConfiguredYetAdd') : t('streams.noStreamsConfiguredYet')}
          >
        <div className="streams-container bg-card text-card-foreground rounded-lg shadow overflow-hidden">
          {/* Bulk action toolbar — visible in selection mode */}
          {canModifyStreams && selectionMode && (
            <div className="flex items-center gap-3 px-4 py-2 border-b border-border">
              <span className="text-sm text-muted-foreground">
                {selectedStreams.size > 0
                  ? t('streams.selectedCount', { count: selectedStreams.size })
                  : t('streams.selectStreams')}
              </span>
              <button
                className="px-3 py-1 text-sm rounded border transition-colors disabled:opacity-50"
                style={{borderColor: 'hsl(var(--success))', color: 'hsl(var(--success))', background: 'transparent'}}
                onMouseOver={e => e.currentTarget.style.backgroundColor = 'hsl(var(--success) / 0.1)'}
                onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}
                disabled={isBulkWorking || selectedStreams.size === 0}
                onClick={handleBulkEnable}
              >
                {isBulkWorking ? t('streams.working') : t('streams.enableSelected')}
              </button>
              <button
                className="px-3 py-1 text-sm rounded border border-input bg-background hover:bg-accent transition-colors disabled:opacity-50"
                disabled={isBulkWorking || selectedStreams.size === 0}
                onClick={handleBulkDisable}
              >
                {isBulkWorking ? t('streams.working') : t('streams.disableSelected')}
              </button>
              <button
                className="px-3 py-1 text-sm rounded border transition-colors disabled:opacity-50"
                style={{borderColor: 'hsl(var(--danger))', color: 'hsl(var(--danger))', background: 'transparent'}}
                onMouseOver={e => e.currentTarget.style.backgroundColor = 'hsl(var(--danger) / 0.1)'}
                onMouseOut={e => e.currentTarget.style.backgroundColor = 'transparent'}
                disabled={isBulkWorking || selectedStreams.size === 0}
                onClick={handleBulkDelete}
              >
                {isBulkWorking ? t('streams.working') : t('streams.deleteSelected')}
              </button>
              <button
                className="ml-auto text-sm text-muted-foreground hover:text-foreground transition-colors"
                onClick={exitSelectionMode}
              >
                {t('common.cancel')}
              </button>
            </div>
          )}
          <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-sm font-semibold text-foreground">
                {sortedStreams.length} {sortedStreams.length === 1 ? 'stream' : 'streams'}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {streamsViewMode === 'grid' ? 'Card view for quick scanning' : 'Table view for dense comparison'}
              </div>
            </div>
            <div className="inline-flex w-fit rounded-md border border-border bg-muted/30 p-1">
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  streamsViewMode === 'table'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                aria-pressed={streamsViewMode === 'table'}
                onClick={() => setStreamsViewMode('table')}
                title="Table view"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
                Table
              </button>
              <button
                type="button"
                className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
                  streamsViewMode === 'grid'
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                aria-pressed={streamsViewMode === 'grid'}
                onClick={() => setStreamsViewMode('grid')}
                title="Grid view"
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z" />
                </svg>
                Grid
              </button>
            </div>
          </div>
          {streamsViewMode === 'table' ? (
          <div className="overflow-x-auto">
            <table id="streams-table" className="min-w-full divide-y divide-border">
              <thead className="bg-muted">
              <tr>
                {canModifyStreams && selectionMode && (
                  <th className="w-8 px-3 py-3">
                    <input
                      type="checkbox"
                      className="w-4 h-4 rounded cursor-pointer"
                      checked={selectedStreams.size > 0 && selectedStreams.size === (sortedStreams || []).length}
                      ref={el => { if (el) el.indeterminate = selectedStreams.size > 0 && selectedStreams.size < (sortedStreams || []).length; }}
                      onChange={toggleSelectAll}
                      title={t('streams.selectAll')}
                    />
                  </th>
                )}
                <th className="w-8 px-2 py-3"></th>
                {[
                  { key: 'name',       label: t('common.name') },
                  { key: 'status',     label: t('common.status') },
                  { key: 'url',        label: t('common.url') },
                  { key: 'resolution', label: t('streams.resolution') },
                  { key: 'fps',        label: t('streams.fps') },
                  { key: 'recording',  label: t('streams.recording') },
                ].map(({ key, label }) => (
                  <th
                    key={key}
                    className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider cursor-pointer select-none hover:text-foreground"
                    onClick={() => handleSort(key)}
                  >
                    <span className="inline-flex items-center gap-1">
                      {label}
                      <span className="inline-flex flex-col leading-none" style={{fontSize: '0.6rem', lineHeight: 1}}>
                        <span style={{opacity: sortColumn === key && sortDirection === 'asc' ? 1 : 0.3}}>▲</span>
                        <span style={{opacity: sortColumn === key && sortDirection === 'desc' ? 1 : 0.3}}>▼</span>
                      </span>
                    </span>
                  </th>
                ))}
                <th className="px-6 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wider">{t('common.actions')}</th>
              </tr>
              </thead>
              <tbody className="bg-card divide-y divide-border">
              {sortedStreams.map(stream => {
                const isExpanded = expandedStreams[stream.name];
                const statusColor =
                  stream.status === 'Running'      ? 'hsl(var(--success))' :
                  stream.status === 'Starting'     ? 'hsl(var(--warning, 45 93% 47%))' :
                  stream.status === 'Reconnecting' ? 'hsl(var(--warning, 45 93% 47%))' :
                  stream.status === 'Error'        ? 'hsl(var(--danger))' :
                  stream.status === 'Stopping'     ? 'hsl(var(--warning, 45 93% 47%))' :
                  stream.status === 'Stopped'      ? 'hsl(var(--danger))' :
                  'hsl(var(--muted-foreground))';
                const statusLabel =
                  stream.status === 'Running'      ? t('streams.running')      :
                  stream.status === 'Starting'     ? t('streams.starting')     :
                  stream.status === 'Reconnecting' ? t('streams.reconnecting') :
                  stream.status === 'Error'        ? t('streams.error')        :
                  stream.status === 'Stopping'     ? t('streams.stopping')     :
                  stream.status === 'Stopped'      ? t('streams.stopped')      :
                  (stream.status || t('common.unknown'));
                const hasAdminLauncher = !shouldHideCredentials && /^https?:\/\//i.test(stream.admin_url || '');

                return (
                  <Fragment key={stream.name}>
                    <tr className="hover:bg-muted/50 cursor-pointer" onClick={() => toggleStreamExpand(stream.name)}>
                      {/* Bulk-select checkbox — only in selection mode */}
                      {canModifyStreams && selectionMode && (
                        <td className="w-8 px-3 py-4" onClick={e => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            className="w-4 h-4 rounded cursor-pointer"
                            checked={selectedStreams.has(stream.name)}
                            onChange={e => toggleSelect(e, stream.name)}
                          />
                        </td>
                      )}
                      {/* Expand/collapse chevron */}
                      <td className="w-8 px-2 py-4 text-center text-muted-foreground">
                        <svg
                          className={`w-4 h-4 inline-block transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                        </svg>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <span className="w-2 h-2 rounded-full mr-2 flex-shrink-0" style={{backgroundColor: stream.enabled ? 'hsl(var(--success))' : 'hsl(var(--danger))'}} title={stream.enabled ? t('common.enabled') : t('common.disabled')}></span>
                          {stream.name}
                        </div>
                      </td>
                      {/* Status badge */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                          style={{
                            backgroundColor: statusColor,
                            color: 'white',
                            opacity: stream.enabled ? 1 : 0.6
                          }}
                        >
                          {statusLabel}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs truncate max-w-xs" title={revealedUrls.has(stream.name) ? stream.url : obfuscateUrlCredentials(stream.url)}>
                            {revealedUrls.has(stream.name) ? stream.url : obfuscateUrlCredentials(stream.url)}
                          </span>
                          {urlHasCredentials(stream.url) && !shouldHideCredentials && (
                            <button
                              type="button"
                              className="flex-shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                              onClick={(e) => toggleUrlReveal(stream.name, e)}
                              title={revealedUrls.has(stream.name) ? t('streams.hideCredentials') : t('streams.showCredentials')}
                            >
                              {revealedUrls.has(stream.name) ? (
                                /* eye-off */
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 4.411m0 0L21 21" />
                                </svg>
                              ) : (
                                /* eye */
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">{stream.width}x{stream.height}</td>
                      <td className="px-6 py-4 whitespace-nowrap">{stream.fps}</td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {stream.record ? t('common.enabled') : t('common.disabled')}
                        {stream.record && stream.record_on_schedule ? ` (${t('streams.schedule')})` : ''}
                        {stream.detection_based_recording
                          ? (stream.record
                            ? ` (${t('streams.detection')} + ${t('streams.continuous', 'Continuous')})`
                            : ` (${t('streams.detection')})`)
                          : ''}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                        <div className="flex space-x-2">
                          {hasAdminLauncher && (
                            <a
                              className="p-1 rounded-full focus:outline-none"
                              style={{color: 'hsl(var(--primary))'}}
                              onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--primary) / 0.1)'}
                              onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                              href={stream.admin_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={t('streams.openCameraAdminPage')}
                              aria-label={t('streams.openAdminPageFor', { name: stream.name })}
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14 3h7m0 0v7m0-7L10 14"></path>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 5h5M5 5v14h14v-5"></path>
                              </svg>
                            </a>
                          )}
                          {/* Edit button - only show if user can modify streams */}
                          {canModifyStreams && (
                            <button
                                className="p-1 rounded-full focus:outline-none"
                                style={{color: 'hsl(var(--primary))'}}
                                onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--primary) / 0.1)'}
                                onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                onClick={() => openEditStreamModal(stream.name)}
                                title={t('common.edit')}
                            >
                              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                                <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"></path>
                              </svg>
                            </button>
                          )}
                          {/* Clone button - only show if user can create streams */}
                          {canCreateStreams && (
                            <button
                                className="p-1 rounded-full focus:outline-none"
                                style={{color: 'hsl(var(--success))'}}
                                onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--success) / 0.1)'}
                                onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                onClick={(e) => { e.stopPropagation(); openCloneStreamModal(stream.name); }}
                                title={t('streams.cloneStream')}
                            >
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                              </svg>
                            </button>
                          )}
                          {/* Enable/Disable toggle button - only show if user can modify streams */}
                          {canModifyStreams && (
                            <button
                                className="p-1 rounded-full focus:outline-none"
                                style={{color: stream.enabled ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))'}}
                                onMouseOver={(e) => e.currentTarget.style.backgroundColor = stream.enabled ? 'hsl(var(--success) / 0.1)' : 'hsl(var(--muted-foreground) / 0.1)'}
                                onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                onClick={(e) => { e.stopPropagation(); handleToggleStreamEnabled(stream); }}
                                title={stream.enabled ? t('streams.toggleDisable') : t('streams.toggleEnable')}
                            >
                              {/* Power icon */}
                              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                              </svg>
                            </button>
                          )}
                          {/* Delete button - only show if user can modify streams */}
                          {canModifyStreams && (
                            <button
                                className="p-1 rounded-full focus:outline-none"
                                style={{color: 'hsl(var(--danger))'}}
                                onMouseOver={(e) => e.currentTarget.style.backgroundColor = 'hsl(var(--danger) / 0.1)'}
                                onMouseOut={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                onClick={() => openDeleteModal(stream)}
                                title={t('common.delete')}
                            >
                              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
                                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd"></path>
                              </svg>
                            </button>
                          )}
                          {/* Show dash when no actions available */}
                          {!canModifyStreams && !hasAdminLauncher && (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {/* Expandable detail row */}
                    {isExpanded && (
                      <tr className="bg-muted/30">
                        <td colSpan={canModifyStreams && selectionMode ? 9 : 8} className="px-6 py-3">
                          <div className="flex flex-wrap gap-4 text-sm">
                            {/* Enabled */}
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-muted-foreground">{t('common.enabled')}:</span>
                              <span style={{color: stream.enabled ? 'hsl(var(--success))' : 'hsl(var(--danger))'}}>
                                {stream.enabled ? t('common.yes') : t('common.no')}
                              </span>
                            </div>
                            {/* Streaming */}
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-muted-foreground">{t('streams.streaming')}:</span>
                              <span style={{color: stream.streaming_enabled ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))'}}>
                                {stream.streaming_enabled ? t('common.active') : t('streams.off')}
                              </span>
                            </div>
                            {/* Recording */}
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-muted-foreground">{t('streams.recording')}:</span>
                              <span style={{color: stream.record ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))'}}>
                                {stream.record
                                  ? (stream.record_on_schedule ? t('streams.scheduled') : t('streams.continuous'))
                                  : t('streams.off')}
                              </span>
                            </div>
                            {/* Detection */}
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-muted-foreground">{t('streams.detection')}:</span>
                              <span style={{color: stream.detection_based_recording ? 'hsl(var(--success))' : 'hsl(var(--muted-foreground))'}}>
                                {stream.detection_based_recording
                                  ? (stream.record
                                    ? `${stream.detection_model ? stream.detection_model.split('/').pop() : t('common.enabled')} (${t('streams.continuous', 'continuous recording active')})`
                                    : (stream.detection_model ? stream.detection_model.split('/').pop() : t('common.enabled')))
                                  : t('streams.off')}
                              </span>
                            </div>
                            {/* Codec */}
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-muted-foreground">{t('streams.codec')}:</span>
                              <span>{stream.codec || t('streams.notAvailable')}</span>
                            </div>
                            {/* Priority */}
                            <div className="flex items-center gap-1.5">
                              <span className="font-medium text-muted-foreground">{t('streams.priority')}:</span>
                              <span>{stream.priority || t('streams.notAvailable')}</span>
                            </div>
                            {/* Segment duration */}
                            {stream.record && (
                              <div className="flex items-center gap-1.5">
                                <span className="font-medium text-muted-foreground">{t('streams.segment')}:</span>
                                <span>{stream.segment_duration
                                  ? (stream.segment_duration >= 60
                                    ? `${Math.round(stream.segment_duration / 60)}min`
                                    : `${stream.segment_duration}s`)
                                  : t('streams.notAvailable')}</span>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
              </tbody>
            </table>
          </div>
          ) : (
          <div id="streams-grid" className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {sortedStreams.map(stream => renderStreamGridCard(stream))}
          </div>
          )}
        </div>
      </ContentLoader>
        </div>
      )}

      {deleteModalVisible && streamToDelete && (
        <StreamDeleteModal
            streamId={streamToDelete.name}
            streamName={streamToDelete.name}
            onClose={closeDeleteModal}
            onDisable={disableStream}
            onDelete={deleteStream}
            isDeleting={deleteStreamMutation.isPending}
            isDisabling={disableStreamMutation.isPending}
        />
      )}

      {bulkActionModal && (
        <StreamBulkActionModal
            action={bulkActionModal}
            streamNames={[...selectedStreams]}
            onClose={() => setBulkActionModal(null)}
            onConfirm={
              bulkActionModal === 'delete'  ? executeBulkDelete  :
              bulkActionModal === 'enable'  ? executeBulkEnable  :
                                              executeBulkDisable
            }
            isWorking={isBulkWorking}
        />
      )}

      {modalVisible && (
        <StreamConfigModal
          isEditing={isEditing}
          isCloning={isCloning}
          currentStream={currentStream}
          detectionModels={detectionModels}
          expandedSections={expandedSections}
          onToggleSection={toggleSection}
          onInputChange={handleInputChange}
          onThresholdChange={handleThresholdChange}
          onTestUrl={testStreamUrl}
          urlProbe={visibleUrlProbe}
          cameraFolders={cameraFolders}
          folderId={newCameraFolderId}
          onFolderChange={setNewCameraFolderId}
          onSwitchToSubnetScan={canCreateStreams ? () => { closeModal(); setSubnetScanVisible(true); } : undefined}
          onTestMotion={triggerTestMotionEvent}
          onSave={handleSubmit}
          onClose={closeModal}
          onRefreshModels={loadDetectionModels}
          hideCredentials={shouldHideCredentials}
          streams={streams}
          locationCatalog={locationCatalog}
        />
      )}

      <SubnetScanModal
        isOpen={subnetScanVisible}
        onClose={() => setSubnetScanVisible(false)}
        onSwitchToKnownAddress={() => { setSubnetScanVisible(false); openAddStreamModal(); }}
        existingNames={streams.map(stream => stream.name)}
        onCamerasAdded={() => queryClient.invalidateQueries({ queryKey: ['streams'] })}
      />
      {onvifModalVisible && (
        <div id="onvif-modal" className="content-modal-backdrop fixed inset-0 bg-black/60 flex items-center justify-center z-50 transition-opacity duration-300 p-4">
          <div className="bg-card text-card-foreground rounded-lg shadow-xl w-full max-w-[1440px] max-h-[94vh] overflow-hidden flex flex-col">
            <div className="flex items-start justify-between gap-4 p-5 border-b border-border">
              <div>
                <h3 className="text-lg font-semibold">{t('streams.cameraDiscovery')}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{t('streams.cameraDiscoveryHelp')}</p>
              </div>
              <button
                type="button"
                className="text-2xl leading-none text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setOnvifModalVisible(false);
                  setIsDiscovering(false);
                }}
                aria-label={t('common.close')}
              >
                ×
              </button>
            </div>

            <div className="p-5 border-b border-border bg-muted/20">
              <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                <div>
                  <label htmlFor="onvif-network-override" className="block text-sm font-medium mb-1">
                    {t('streams.discoveryNetwork')}
                  </label>
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <input
                      type="text"
                      id="onvif-network-override"
                      className="px-3 py-2 border border-input rounded-md bg-background text-foreground w-full max-w-sm text-sm focus:outline-none focus:ring-2 focus:ring-primary"
                      value={onvifNetworkOverride}
                      onChange={(e) => setOnvifNetworkOverride(e.target.value)}
                      disabled
                      placeholder={t('streams.auto')}
                    />
                    <span className="text-xs text-muted-foreground">
                      {t('streams.discoveryNetworkHelp')}
                    </span>
                  </div>
                </div>
                <div className={`inline-flex h-10 items-center rounded-md border px-3 text-sm font-medium ${
                  isDiscovering
                    ? 'border-primary/25 bg-primary/10 text-primary'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                }`}>
                  {isDiscovering ? (
                    <span className="flex items-center">
                      {t('streams.discovering')}
                      <span className="ml-1 flex space-x-1">
                        <span className="animate-pulse delay-0 h-1.5 w-1.5 bg-current rounded-full"></span>
                        <span className="animate-pulse delay-150 h-1.5 w-1.5 bg-current rounded-full"></span>
                        <span className="animate-pulse delay-300 h-1.5 w-1.5 bg-current rounded-full"></span>
                      </span>
                    </span>
                  ) : 'Discovery complete'}
                </div>
              </div>
            </div>

            <div className="grid min-h-0 flex-1 lg:grid-cols-[minmax(0,1fr)_380px]">
              <div className="min-h-0 overflow-y-auto p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-base font-semibold">{t('streams.discoveredDevices')}</h4>
                    <p className="text-xs text-muted-foreground">
                      {discoveredDevices.length > 0
                        ? t('streams.discoveredDeviceCount', { count: discoveredDevices.length })
                        : t('streams.discoveryDeviceListHelp')}
                    </p>
                  </div>
                </div>

                {discoveredDevices.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-border bg-muted/20 p-8 text-center text-muted-foreground">
                    {isDiscovering ? (
                      <div className="flex items-center justify-center">
                        <span>{t('streams.discoveringDevices')}</span>
                        <span className="ml-1 flex space-x-1">
                          <span className="animate-pulse delay-0 h-1.5 w-1.5 bg-muted-foreground rounded-full"></span>
                          <span className="animate-pulse delay-150 h-1.5 w-1.5 bg-muted-foreground rounded-full"></span>
                          <span className="animate-pulse delay-300 h-1.5 w-1.5 bg-muted-foreground rounded-full"></span>
                        </span>
                      </div>
                    ) : t('streams.noDevicesDiscoveredYet')}
                  </div>
                ) : (
                  <div className="space-y-2">
                    {discoveredDevices.map(device => {
                      const alreadyAdded = isDeviceAlreadyAdded(device);
                      const isSelected = selectedDevice && selectedDevice.ip_address === device.ip_address;
                      const ports = Array.isArray(device.rtsp_ports) ? device.rtsp_ports : [];
                      return (
                        <div
                          key={device.ip_address}
                          role="button"
                          tabIndex={0}
                          className={`w-full rounded-lg border p-4 text-left transition-colors ${
                            isSelected
                              ? 'border-primary bg-primary/5'
                              : 'border-border bg-background hover:bg-muted/40'
                          }`}
                          onClick={() => {
                            selectDiscoveredDevice(device);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              selectDiscoveredDevice(device);
                            }
                          }}
                        >
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono text-base font-semibold text-foreground">{device.ip_address}</span>
                                <span className="inline-flex items-center rounded-full border border-primary/20 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                                  {getDiscoveryDeviceType(device)}
                                </span>
                                {alreadyAdded && (
                                  <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                                    {t('streams.alreadyAdded')}
                                  </span>
                                )}
                              </div>
                              <div className="mt-2 grid gap-1 text-sm text-muted-foreground md:grid-cols-3">
                                <span>{t('streams.manufacturer')}: <span className="text-foreground">{device.manufacturer || t('common.unknown')}</span></span>
                                <span>{t('streams.model')}: <span className="text-foreground">{device.model || t('common.unknown')}</span></span>
                                {ports.length > 0 && (
                                  <span>{t('streams.rtspPorts')}: <span className="text-foreground">{ports.join(', ')}</span></span>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 sm:flex-shrink-0">
                              <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${getDiscoveryStatusClass(device)}`}>
                                {device.status || (device.rtsp ? 'RTSP Found' : 'Discovered')}
                              </span>
                              <button
                                className={isSelected || alreadyAdded ? 'btn-secondary focus:outline-none' : 'btn-primary focus:outline-none'}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectDiscoveredDevice(device);
                                }}
                                type="button"
                                title={alreadyAdded ? t('streams.deviceAlreadyInUseTitle') : undefined}
                              >
                                {isSelected ? 'Selected' : alreadyAdded ? t('streams.connectAnyway') : t('streams.connect')}
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <aside className="min-h-0 overflow-y-auto border-t border-border bg-muted/15 p-5 lg:border-l lg:border-t-0">
                <div className="space-y-5">
                  <div className="rounded-lg border border-border bg-background p-4">
                    <h4 className="text-sm font-semibold">{t('streams.selectedDevice')}</h4>
                    {selectedDevice ? (
                      <div className="mt-3 space-y-4 text-sm">
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">{t('streams.ipAddress')}</span>
                          <span className="font-mono text-foreground">{selectedDevice.ip_address}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">{t('streams.deviceType')}</span>
                          <span className="text-foreground">{getDiscoveryDeviceType(selectedDevice)}</span>
                        </div>
                        <div className="flex justify-between gap-3">
                          <span className="text-muted-foreground">{t('common.status')}</span>
                          <span className="text-foreground">{selectedDevice.status || (selectedDevice.rtsp ? 'RTSP Found' : 'Discovered')}</span>
                        </div>
                        {selectedDeviceAlreadyAdded && (
                          <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                            {t('streams.deviceAlreadyInUseTitle')}
                          </p>
                        )}
                        <div className="border-t border-border pt-4">
                          <h4 className="text-base font-semibold">{t('streams.authentication')}</h4>
                          <p className="mt-1 text-sm text-muted-foreground">{t('streams.onvifAuthenticationHelp')}</p>
                          <div className="mt-4 space-y-3">
                            <div className="form-group">
                              <label htmlFor="onvif-username" className="block text-sm font-medium mb-1">{t('auth.username')}</label>
                              <input
                                type="text"
                                id="onvif-username"
                                name="username"
                                className="w-full px-3 py-2 border border-input rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                                placeholder="admin"
                                value={onvifCredentials.username}
                                onChange={handleCredentialChange}
                              />
                            </div>
                            <div className="form-group">
                              <label htmlFor="onvif-password" className="block text-sm font-medium mb-1">{t('auth.password')}</label>
                              <div className="relative">
                                <input
                                  type={showDiscoveryPassword ? 'text' : 'password'}
                                  id="onvif-password"
                                  name="password"
                                  className="w-full rounded-md border border-input bg-background px-3 py-2 pr-11 text-foreground shadow-sm focus:outline-none focus:ring-2 focus:ring-primary"
                                  placeholder="password"
                                  value={onvifCredentials.password}
                                  onChange={handleCredentialChange}
                                />
                                <button
                                  type="button"
                                  className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-muted-foreground hover:text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                  onClick={() => setShowDiscoveryPassword(prev => !prev)}
                                  aria-label={showDiscoveryPassword ? 'Hide password' : 'Show password'}
                                  title={showDiscoveryPassword ? 'Hide password' : 'Show password'}
                                >
                                  {showDiscoveryPassword ? (
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12c.74-2.1 2.05-3.89 3.72-5.19" />
                                      <path d="M9.9 4.24A10.68 10.68 0 0 1 12 4c5 0 9.27 3.11 11 8a11.45 11.45 0 0 1-2.16 3.19" />
                                      <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
                                      <path d="M1 1l22 22" />
                                    </svg>
                                  ) : (
                                    <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
                                      <circle cx="12" cy="12" r="3" />
                                    </svg>
                                  )}
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="btn-primary w-full focus:outline-none focus:ring-2 focus:ring-primary"
                          disabled={isLoadingProfiles}
                          onClick={() => testOnvifConnection(selectedDevice)}
                        >
                          {isLoadingProfiles ? t('common.loading') : t('streams.connect')}
                        </button>

                        <div className="rounded-lg border border-border bg-muted/25 p-4">
                          <h4 className="text-sm font-semibold">Selected stream pair</h4>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Choose a primary stream and optional secondary stream from the same camera, then continue once.
                          </p>
                          <div className="mt-3 space-y-2 text-sm">
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-muted-foreground">Primary</span>
                              <span className="text-right text-foreground">
                                {selectedProfile ? selectedProfile.name : 'Not selected'}
                              </span>
                            </div>
                            <div className="flex items-start justify-between gap-3">
                              <span className="text-muted-foreground">Secondary</span>
                              <span className="text-right text-foreground">
                                {selectedSecondaryProfile ? selectedSecondaryProfile.name : 'Optional'}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn-primary mt-4 w-full focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                            disabled={!selectedProfile}
                            onClick={openSelectedDiscoveryStream}
                          >
                            Continue
                          </button>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-2 text-sm text-muted-foreground">{t('streams.selectDeviceHelp')}</p>
                    )}
                  </div>

                  {selectedDevice && rankedDeviceProfiles.length > 0 && (
                    <div className="rounded-lg border border-border bg-background p-4">
                      <h4 className="text-sm font-semibold">{t('streams.availableProfilesFor', { ip: selectedDevice.ip_address })}</h4>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Primary and secondary streams are shown first so you can add both from the same camera.
                      </p>
                      <div className="mt-3 space-y-2">
                        {rankedDeviceProfiles[0] && renderDiscoveredProfileCard(rankedDeviceProfiles[0], 0, 'primary')}
                        {rankedDeviceProfiles[1] && renderDiscoveredProfileCard(rankedDeviceProfiles[1], 1, 'secondary')}
                        {rankedDeviceProfiles.length > 2 && (
                          <div className="space-y-2 pt-1">
                            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Additional profiles</div>
                            {rankedDeviceProfiles.slice(2).map((profile, index) => renderDiscoveredProfileCard(profile, index + 2))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              </aside>
            </div>

            <div className="flex justify-end p-4 border-t border-border">
              <button
                id="onvif-close-btn"
                className="px-4 py-2 bg-secondary text-secondary-foreground rounded hover:bg-secondary/80 transition-colors"
                onClick={() => {
                  setOnvifModalVisible(false);
                  setIsDiscovering(false);
                  setShowCustomNameInput(false);
                }}
                type="button"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCustomNameInput && (
        <div id="custom-name-modal" className="content-modal-backdrop fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 transition-opacity duration-300">
          <div className="bg-card text-card-foreground rounded-lg shadow-xl max-w-md w-full">
            <div className="flex justify-between items-center p-4 border-b border-border">
              <h3 className="text-lg font-medium">{t('streams.streamName')}</h3>
              <span
                className="text-2xl cursor-pointer"
                onClick={() => {
                  setShowCustomNameInput(false);
                  setSelectedProfile(null);
                  setSelectedSecondaryProfile(null);
                }}
              >
                ×
              </span>
            </div>
            <div className="p-4">
              <div className="mb-4">
                <label htmlFor="custom-stream-name" className="block text-sm font-medium mb-1">{t('streams.enterNameForStream')}</label>
                <input
                    type="text"
                    id="custom-stream-name"
                    className="w-full px-3 py-2 border border-input rounded-md shadow-sm focus:outline-none bg-background text-foreground"
                    value={customStreamName}
                    onChange={(e) => setCustomStreamName(e.target.value)}
                />
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('streams.streamNameHelp')}
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="onvif-stream-resolution" className="block text-sm font-medium mb-1">{t('streams.resolution')}</label>
                  <select
                    id="onvif-stream-resolution"
                    className="w-full px-3 py-2 border border-input rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                    value={onvifResolution}
                    onChange={(e) => setOnvifResolution(e.target.value)}
                  >
                    {onvifResolutionOptions.map(option => (
                      <option key={option.value || 'auto'} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">Leave Auto to keep the camera profile resolution.</p>
                </div>
                <div>
                  <label htmlFor="onvif-stream-fps" className="block text-sm font-medium mb-1">{t('streams.fps')}</label>
                  <select
                    id="onvif-stream-fps"
                    className="w-full px-3 py-2 border border-input rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-primary bg-background text-foreground"
                    value={onvifFps}
                    onChange={(e) => setOnvifFps(e.target.value)}
                  >
                    {onvifFpsOptions.map(option => (
                      <option key={option.value || 'auto'} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-muted-foreground">Leave Auto to keep the camera profile frame rate.</p>
                </div>
              </div>
            </div>
            <div className="flex justify-end p-4 border-t border-border space-x-2">
              <button
                  className="px-4 py-2 bg-secondary text-secondary-foreground rounded hover:bg-secondary/80 transition-colors"
                  onClick={() => {
                    setShowCustomNameInput(false);
                    setSelectedProfile(null);
                    setSelectedSecondaryProfile(null);
                  }}
                  type="button"
              >
                {t('common.cancel')}
              </button>
              <button
                  className="btn-primary focus:outline-none focus:ring-2 focus:ring-primary"
                  onClick={submitOnvifDevice}
                  type="button"
                  disabled={!customStreamName.trim() || isAddingStream}
              >
                {isAddingStream ? (
                  <span className="flex items-center">
                    {t('common.adding')}
                    <span className="ml-1 flex space-x-1">
                      <span className="animate-pulse delay-0 h-1.5 w-1.5 bg-white rounded-full"></span>
                      <span className="animate-pulse delay-150 h-1.5 w-1.5 bg-white rounded-full"></span>
                      <span className="animate-pulse delay-300 h-1.5 w-1.5 bg-white rounded-full"></span>
                    </span>
                  </span>
                ) : t('streams.addStream')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
