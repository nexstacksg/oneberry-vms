import {
  getUrlHost,
  matchCameraSearch,
  parseCameraSearch,
  stripUrlCredentials,
} from '../js/utils/camera-search-utils.js';

const camera = {
  name: 'Lobby Entrance',
  url: 'rtsp://admin:S3cret!@172.16.3.110:554/Streaming/Channels/101',
  secondary_url: 'rtsp://admin:S3cret!@172.16.3.110:554/Streaming/Channels/102',
};
const search = (query, stream = camera) => matchCameraSearch(stream, parseCameraSearch(query));

describe('camera search', () => {
  it('removes user name and password from links', () => {
    expect(stripUrlCredentials(camera.url)).toBe('rtsp://172.16.3.110:554/Streaming/Channels/101');
    expect(stripUrlCredentials('rtsp://10.0.0.5/live')).toBe('rtsp://10.0.0.5/live');
    expect(getUrlHost(camera.url)).toBe('172.16.3.110');
    expect(getUrlHost('rtsp://cam.example.local:8554/x')).toBe('cam.example.local');
    expect(getUrlHost('not a link')).toBe('');
  });

  it('empty search shows every camera', () => {
    expect(search('')).toEqual({ field: 'name', hint: '' });
    expect(search('   ')).toEqual({ field: 'name', hint: '' });
  });

  it('finds by name, any case, with a hint only when the name did not match', () => {
    expect(search('lobby')).toEqual({ field: 'name', hint: '' });
    expect(search('ENTR')).toEqual({ field: 'name', hint: '' });
    expect(search('garage')).toBeNull();
  });

  it('finds by IP address, also a part of it', () => {
    expect(search('172.16.3.110')).toEqual({ field: 'ip', hint: '172.16.3.110' });
    expect(search('3.110')).toEqual({ field: 'ip', hint: '172.16.3.110' });
    expect(search('172.16.4')).toBeNull();
  });

  it('finds by RTSP link (port, path, whole link without password)', () => {
    expect(search('Channels/102')).toEqual({ field: 'url', hint: 'rtsp://172.16.3.110:554/Streaming/Channels/102' });
    expect(search(':554')).toEqual({ field: 'url', hint: 'rtsp://172.16.3.110:554/Streaming/Channels/101' });
    expect(search('rtsp://172.16.3.110:554/Streaming/Channels/101')?.field).toBe('url');
  });

  it('never matches the user name or password', () => {
    expect(search('S3cret')).toBeNull();
    expect(search('admin:')).toBeNull();
    expect(search('rtsp://admin')).toBeNull();
  });

  it('all words must match (name and IP together)', () => {
    expect(search('lobby 3.110')).toEqual({ field: 'ip', hint: '172.16.3.110' });
    expect(search('lobby 9.999')).toBeNull();
  });

  it('cameras without links still match by name', () => {
    expect(search('cam', { name: 'cam-55' })).toEqual({ field: 'name', hint: '' });
    expect(search('172', { name: 'cam-55' })).toBeNull();
  });

  it('finds by tag', () => {
    const tagged = { ...camera, tags: 'outdoor, gate' };
    expect(search('outdoor', tagged)).toEqual({ field: 'tag', hint: '#outdoor' });
    expect(search('lobby gate', tagged)).toEqual({ field: 'tag', hint: '#gate' });
    expect(search('indoor', tagged)).toBeNull();
  });
});
