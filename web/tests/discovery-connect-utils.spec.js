import { connectDiscoveredDevices, pickStreamProfiles } from '../js/utils/discovery-connect-utils.js';

const hik = (ip, extra = {}) => ({
  ip_address: ip, manufacturer: 'HIKVISION', model: 'DS-2CD2622FWD-I', onvif: true,
  device_service: `http://${ip}/onvif/device_service`, ...extra,
});
const profiles = (ip) => [
  { token: 'Profile_2', name: 'subStream', stream_uri: `rtsp://${ip}:554/Streaming/Channels/102`, width: 640, height: 360 },
  { token: 'Profile_1', name: 'mainStream', stream_uri: `rtsp://${ip}:554/Streaming/Channels/101`, width: 1920, height: 1080 },
];

describe('pickStreamProfiles', () => {
  it('uses the largest profile as main and the smallest other one as sub', () => {
    const { main, sub } = pickStreamProfiles(profiles('10.0.0.1'));
    expect(main.token).toBe('Profile_1');
    expect(sub.token).toBe('Profile_2');
  });
  it('has no sub stream when there is only one usable profile', () => {
    const { main, sub } = pickStreamProfiles([{ token: 'a', stream_uri: 'rtsp://x/1', width: 1280, height: 720 }, { token: 'b', stream_uri: '' }]);
    expect(main.token).toBe('a');
    expect(sub).toBeNull();
  });
  it('handles no profiles', () => {
    expect(pickStreamProfiles([])).toEqual({ main: null, sub: null });
    expect(pickStreamProfiles(undefined)).toEqual({ main: null, sub: null });
  });
});

describe('connectDiscoveredDevices', () => {
  const credentials = { username: 'admin', password: 'site-pass' };
  const setup = (overrides = {}) => {
    const created = [];
    const options = {
      credentials,
      existingNames: [],
      fetchProfiles: jest.fn(async (device) => profiles(device.ip_address)),
      createStream: jest.fn(async (payload) => { created.push(payload); }),
      onUpdate: jest.fn(),
      ...overrides,
    };
    return { options, created };
  };

  it('connects several cameras with the same credentials', async () => {
    const { options, created } = setup();
    const results = await connectDiscoveredDevices([hik('172.16.3.201'), hik('172.16.3.202')], options);
    expect(Object.values(results).map((r) => r.state)).toEqual(['connected', 'connected']);
    expect(options.fetchProfiles).toHaveBeenCalledWith(expect.objectContaining({ ip_address: '172.16.3.201' }), credentials);
    expect(created[0]).toMatchObject({
      name: 'hikvision-172-16-3-201',
      url: 'rtsp://admin:site-pass@172.16.3.201:554/Streaming/Channels/101',
      secondary_url: 'rtsp://admin:site-pass@172.16.3.201:554/Streaming/Channels/102',
      isOnvif: true, onvif_username: 'admin', onvif_password: 'site-pass', onvif_profile: 'Profile_1',
      width: 1920, height: 1080,
    });
  });

  it('keeps going when one camera rejects the credentials', async () => {
    const { options, created } = setup({
      fetchProfiles: jest.fn(async (device) => {
        if (device.ip_address === '172.16.3.202') throw new Error('The camera rejected this username and password for ONVIF.');
        return profiles(device.ip_address);
      }),
    });
    const results = await connectDiscoveredDevices([hik('172.16.3.201'), hik('172.16.3.202'), hik('172.16.3.203')], options);
    expect(results['172.16.3.201'].state).toBe('connected');
    expect(results['172.16.3.202']).toMatchObject({ state: 'failed', message: expect.stringContaining('rejected') });
    expect(results['172.16.3.203'].state).toBe('connected');
    expect(created).toHaveLength(2);
  });

  it('reports cameras without streams, non-ONVIF devices and create failures', async () => {
    const { options, created } = setup({
      fetchProfiles: jest.fn(async (device) => (device.ip_address === '10.0.0.2' ? [] : profiles(device.ip_address))),
      createStream: jest.fn(async () => { throw new Error('Stream already exists'); }),
    });
    const results = await connectDiscoveredDevices([
      hik('10.0.0.1'), hik('10.0.0.2'), hik('10.0.0.3', { onvif: false }),
    ], options);
    expect(results['10.0.0.1']).toMatchObject({ state: 'failed', message: 'Stream already exists' });
    expect(results['10.0.0.2'].message).toMatch(/did not return any video/);
    expect(results['10.0.0.3'].message).toMatch(/Not an ONVIF camera/);
    expect(created).toHaveLength(0);
  });

  it('avoids names that already exist', async () => {
    const { options, created } = setup({ existingNames: ['hikvision-172-16-3-201'] });
    await connectDiscoveredDevices([hik('172.16.3.201')], options);
    expect(created[0].name).toBe('hikvision-172-16-3-201-2');
  });

  it('reports progress for each camera', async () => {
    const { options } = setup();
    await connectDiscoveredDevices([hik('172.16.3.201')], options);
    expect(options.onUpdate.mock.calls.map(([ip, r]) => `${ip}:${r.state}`)).toEqual(['172.16.3.201:connecting', '172.16.3.201:connected']);
  });
});
