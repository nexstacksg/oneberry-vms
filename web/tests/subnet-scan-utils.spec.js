import {
  connectSelectedDevices,
  devicePortLabel,
  deviceStatusLabel,
  ipToNumber,
  isDeviceSelectable,
  makeCameraName,
  validateIpRange,
  validatePort,
} from '../js/utils/subnet-scan-utils.js';
import { applyCredentialsToStreamUrl, buildDiscoveredStreamPayload } from '../js/utils/discovered-stream-utils.js';

const onvifDevice = (ip, extra = {}) => ({
  ip, protocol: 'onvif', brand: 'Hikvision', model: 'DS-2CD', onvifPort: 80, rtspPort: 554,
  onvifLogin: true, profileToken: 'Profile_1', authStatus: 'ready', alreadyAdded: false,
  streamUrl: `rtsp://${ip}:554/Streaming/Channels/101`, subStreamUrl: `rtsp://${ip}:554/Streaming/Channels/102`,
  width: 1920, height: 1080, message: '', ...extra,
});
const rtspDevice = (ip, extra = {}) => ({
  ip, protocol: 'rtsp', brand: 'Unknown', model: 'Unknown', rtspPort: 554, authStatus: 'ready',
  alreadyAdded: false, streamUrl: `rtsp://${ip}:554/live`, subStreamUrl: '', width: 0, height: 0, message: '', ...extra,
});

describe('IP range validation', () => {
  it('accepts a full /24 range', () => {
    expect(validateIpRange('172.16.3.1', '172.16.3.255')).toEqual({ valid: true, hostCount: 255 });
  });
  it('accepts a single address', () => {
    expect(validateIpRange('172.16.3.1', '172.16.3.1')).toEqual({ valid: true, hostCount: 1 });
  });
  it('rejects invalid addresses', () => {
    expect(validateIpRange('172.16.3.300', '172.16.3.1').error).toMatch(/Start IP/);
    expect(validateIpRange('172.16.3.1', 'abc').error).toMatch(/End IP/);
    expect(validateIpRange('172.16.3', '172.16.3.9').valid).toBe(false);
    expect(validateIpRange('', '172.16.3.9').valid).toBe(false);
    expect(ipToNumber('01.2.3.4x')).toBeNull();
  });
  it('rejects start greater than end', () => {
    expect(validateIpRange('172.16.3.255', '172.16.3.1').error).toMatch(/greater/);
  });
  it('rejects too-large ranges', () => {
    expect(validateIpRange('0.0.0.0', '255.255.255.255').valid).toBe(false);
    expect(validateIpRange('10.0.0.0', '10.0.255.255').error).toMatch(/too large/);
    expect(validateIpRange('10.0.0.0', '10.0.3.255').valid).toBe(true); // exactly 1024
  });
  it('rejects public addresses', () => {
    expect(validateIpRange('8.8.8.1', '8.8.8.9').error).toMatch(/private/);
  });
  it('validates the port', () => {
    expect(validatePort('')).toEqual({ valid: true, port: 554 });
    expect(validatePort('8554')).toEqual({ valid: true, port: 8554 });
    expect(validatePort('0').valid).toBe(false);
    expect(validatePort('70000').valid).toBe(false);
    expect(validatePort('55.4').valid).toBe(false);
  });
});

describe('discovered device statuses', () => {
  it('shows an ONVIF device as Ready with both ports', () => {
    const device = onvifDevice('172.16.3.201');
    expect(deviceStatusLabel(device)).toBe('Ready');
    expect(devicePortLabel(device)).toBe('80/554');
    expect(isDeviceSelectable(device)).toBe(true);
  });
  it('shows an RTSP-only device with its RTSP port', () => {
    const device = rtspDevice('172.16.3.235');
    expect(devicePortLabel(device)).toBe('554');
    expect(isDeviceSelectable(device)).toBe(true);
  });
  it('lets credential failures be selected (credentials are asked on connect)', () => {
    const device = onvifDevice('172.16.3.215', { authStatus: 'credentials_failed' });
    expect(deviceStatusLabel(device)).toBe('Credentials Failed');
    expect(isDeviceSelectable(device)).toBe(true);
  });
  it('never lets an already-added camera be selected', () => {
    const device = onvifDevice('172.16.3.235', { alreadyAdded: true });
    expect(deviceStatusLabel(device)).toBe('Already Added');
    expect(isDeviceSelectable(device)).toBe(false);
  });
  it('does not select devices without a usable stream', () => {
    expect(isDeviceSelectable(rtspDevice('172.16.3.9', { authStatus: 'needs_rtsp_path' }))).toBe(false);
    expect(isDeviceSelectable(rtspDevice('172.16.3.9', { authStatus: 'busy' }))).toBe(false);
    expect(deviceStatusLabel(rtspDevice('172.16.3.9', { authStatus: 'needs_rtsp_path' }))).toBe('Needs RTSP path');
  });
  it('shows connection progress over the scan status', () => {
    const device = onvifDevice('172.16.3.201');
    expect(deviceStatusLabel(device, { state: 'connecting' })).toBe('Connecting…');
    expect(deviceStatusLabel(device, { state: 'connected' })).toBe('Connected');
    expect(deviceStatusLabel(device, { state: 'failed' })).toBe('Connection failed');
    expect(isDeviceSelectable(device, { state: 'connected' })).toBe(false);
  });
  it('makes unique camera names', () => {
    const taken = new Set(['hikvision-172-16-3-201']);
    expect(makeCameraName(onvifDevice('172.16.3.201'), taken)).toBe('hikvision-172-16-3-201-2');
    expect(makeCameraName(rtspDevice('172.16.3.235'), taken)).toBe('camera-172-16-3-235');
  });
});

describe('connectSelectedDevices', () => {
  const common = { username: 'admin', password: 'common-pass' };
  const setup = (overrides = {}) => {
    const created = [];
    const options = {
      commonCredentials: common,
      existingNames: [],
      authenticate: jest.fn(),
      createStream: jest.fn(async (payload) => { created.push(payload); }),
      requestCredentials: jest.fn(async () => null),
      onUpdate: jest.fn(),
      ...overrides,
    };
    return { options, created };
  };

  it('connects multiple cameras with the common credentials', async () => {
    const { options, created } = setup();
    const results = await connectSelectedDevices(
      [onvifDevice('172.16.3.201'), onvifDevice('172.16.3.205'), rtspDevice('172.16.3.235')], options);
    expect(Object.values(results).map(r => r.state)).toEqual(['connected', 'connected', 'connected']);
    expect(created).toHaveLength(3);
    expect(created[0].url).toBe('rtsp://admin:common-pass@172.16.3.201:554/Streaming/Channels/101');
    expect(created[0].secondary_url).toContain('admin:common-pass@');
    expect(created[0].isOnvif).toBe(true);
    expect(created[0].onvif_profile).toBe('Profile_1');
    expect(created[2].isOnvif).toBe(false);
    expect(options.requestCredentials).not.toHaveBeenCalled();
  });

  it('keeps going when one camera fails', async () => {
    const { options } = setup({
      createStream: jest.fn(async (payload) => {
        if (payload.url.includes('172.16.3.205')) throw new Error('Stream with this name already exists');
      }),
    });
    const results = await connectSelectedDevices(
      [onvifDevice('172.16.3.201'), onvifDevice('172.16.3.205'), onvifDevice('172.16.3.210')], options);
    expect(results['172.16.3.201'].state).toBe('connected');
    expect(results['172.16.3.205']).toMatchObject({ state: 'failed', message: 'Stream with this name already exists' });
    expect(results['172.16.3.210'].state).toBe('connected');
  });

  it('asks for credentials and connects when the retry succeeds', async () => {
    const failed = onvifDevice('172.16.3.215', { authStatus: 'credentials_failed', streamUrl: '' });
    const { options, created } = setup({
      requestCredentials: jest.fn(async () => ({ username: 'cam-user', password: 'cam-pass', applyToOthers: false })),
      authenticate: jest.fn(async () => onvifDevice('172.16.3.215')),
    });
    const results = await connectSelectedDevices([failed], options);
    expect(options.requestCredentials).toHaveBeenCalledWith(failed, expect.any(String));
    expect(options.authenticate).toHaveBeenCalledWith('172.16.3.215', { username: 'cam-user', password: 'cam-pass' });
    expect(results['172.16.3.215'].state).toBe('connected');
    expect(created[0].url).toContain('cam-user:cam-pass@');
  });

  it('shows the error again when the retry fails, and skips the camera if the user gives up', async () => {
    const failed = rtspDevice('172.16.3.235', { authStatus: 'credentials_failed', streamUrl: '' });
    const requestCredentials = jest.fn()
      .mockResolvedValueOnce({ username: 'admin', password: 'wrong' })
      .mockResolvedValueOnce(null);
    const { options, created } = setup({
      requestCredentials,
      authenticate: jest.fn(async () => ({ ...failed, message: 'The camera rejected the username or password' })),
    });
    const results = await connectSelectedDevices([failed, onvifDevice('172.16.3.201')], options);
    expect(requestCredentials).toHaveBeenCalledTimes(2);
    expect(requestCredentials.mock.calls[1][1]).toBe('The camera rejected the username or password');
    expect(results['172.16.3.235'].state).toBe('failed');
    expect(results['172.16.3.201'].state).toBe('connected');
    expect(created).toHaveLength(1);
  });

  it('reuses credentials for other failed cameras when asked to', async () => {
    const a = onvifDevice('172.16.3.215', { authStatus: 'credentials_failed' });
    const b = onvifDevice('172.16.3.216', { authStatus: 'credentials_failed' });
    const { options } = setup({
      requestCredentials: jest.fn(async () => ({ username: 'site', password: 'site-pass', applyToOthers: true })),
      authenticate: jest.fn(async (ip) => onvifDevice(ip)),
    });
    const results = await connectSelectedDevices([a, b], options);
    expect(options.requestCredentials).toHaveBeenCalledTimes(1);
    expect(options.authenticate).toHaveBeenLastCalledWith('172.16.3.216', { username: 'site', password: 'site-pass' });
    expect(results['172.16.3.216'].state).toBe('connected');
  });

  it('never registers an already-added camera or one without a stream', async () => {
    const { options, created } = setup();
    const results = await connectSelectedDevices([
      onvifDevice('172.16.3.235', { alreadyAdded: true }),
      rtspDevice('172.16.3.9', { authStatus: 'needs_rtsp_path', streamUrl: '' }),
    ], options);
    expect(results['172.16.3.235'].state).toBe('skipped');
    expect(results['172.16.3.9'].state).toBe('failed');
    expect(created).toHaveLength(0);
  });

  it('uses credentials already confirmed for a camera instead of the common ones', async () => {
    const { options, created } = setup({ deviceCredentials: { '172.16.3.215': { username: 'cam', password: 'own' } } });
    await connectSelectedDevices([onvifDevice('172.16.3.215'), onvifDevice('172.16.3.201')], options);
    expect(created[0].url).toContain('cam:own@172.16.3.215');
    expect(created[0].onvif_password).toBe('own');
    expect(created[1].url).toContain('admin:common-pass@172.16.3.201');
  });

  it('avoids duplicate names with existing cameras', async () => {
    const { options, created } = setup({ existingNames: ['Hikvision-172-16-3-201'] });
    await connectSelectedDevices([onvifDevice('172.16.3.201')], options);
    expect(created[0].name).toBe('hikvision-172-16-3-201-2');
  });
});

describe('discovered stream payload', () => {
  it('matches what the Camera Discovery flow sends', () => {
    expect(buildDiscoveredStreamPayload({
      name: ' front ', streamUrl: 'rtsp://10.0.0.5/s1', secondaryUrl: 'rtsp://10.0.0.5/s2',
      username: 'u', password: 'p@ss', isOnvif: true, onvifProfile: 'tok', width: 1280, height: 720, fps: 15,
    })).toEqual({
      name: 'front', url: 'rtsp://u:p%40ss@10.0.0.5/s1', secondary_url: 'rtsp://u:p%40ss@10.0.0.5/s2',
      enabled: true, streaming_enabled: true, width: 1280, height: 720, fps: 15,
      protocol: '0', priority: '5', segment_duration: 60, record: true, record_audio: false,
      backchannel_enabled: false, retention_days: 1, detection_retention_days: 1,
      isOnvif: true, onvif_username: 'u', onvif_password: 'p@ss', onvif_profile: 'tok', onvif_port: 0,
    });
  });
  it('does not send ONVIF credentials for RTSP-only cameras', () => {
    const payload = buildDiscoveredStreamPayload({ name: 'x', streamUrl: 'rtsp://10.0.0.5/live', username: 'u', password: 'p' });
    expect(payload.isOnvif).toBe(false);
    expect(payload.onvif_password).toBe('');
    expect(payload.secondary_url).toBe('');
  });
  it('replaces credentials already in a URL', () => {
    expect(applyCredentialsToStreamUrl('rtsp://old:old@10.0.0.5/live', 'new', 'pw')).toBe('rtsp://new:pw@10.0.0.5/live');
    expect(applyCredentialsToStreamUrl('rtsp://10.0.0.5/live', '', '')).toBe('rtsp://10.0.0.5/live');
  });
});
