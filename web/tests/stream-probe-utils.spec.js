import {
  detectedInfoToFormFields,
  formatDetectedSummary,
  isProbeableStreamUrl,
  normalizeDetectedCodec,
} from '../js/utils/stream-probe-utils.js';

describe('stream-probe-utils', () => {
  describe('isProbeableStreamUrl', () => {
    it('accepts complete RTSP URLs', () => {
      expect(isProbeableStreamUrl('rtsp://192.168.1.10:554/stream1')).toBe(true);
      expect(isProbeableStreamUrl('rtsp://admin:pass@10.0.0.5/ISAPI/Streaming/channels/101')).toBe(true);
      expect(isProbeableStreamUrl('rtsp://camera.local')).toBe(true);
      expect(isProbeableStreamUrl('rtsps://cam.example.com:322/live')).toBe(true);
      expect(isProbeableStreamUrl('  rtsp://10.0.0.5/live  ')).toBe(true);
    });

    it('rejects partial or non-RTSP input', () => {
      expect(isProbeableStreamUrl('')).toBe(false);
      expect(isProbeableStreamUrl(undefined)).toBe(false);
      expect(isProbeableStreamUrl('rtsp://')).toBe(false);
      expect(isProbeableStreamUrl('rtsp://admin:pass@')).toBe(false);
      expect(isProbeableStreamUrl('rtsp://10.0.0.5:')).toBe(false);
      expect(isProbeableStreamUrl('http://10.0.0.5/video')).toBe(false);
      expect(isProbeableStreamUrl('rtsp://10.0.0.5/has space')).toBe(false);
    });
  });

  describe('normalizeDetectedCodec', () => {
    it('maps FFmpeg decoder names to form options', () => {
      expect(normalizeDetectedCodec('h264')).toBe('h264');
      expect(normalizeDetectedCodec('hevc')).toBe('h265');
      expect(normalizeDetectedCodec('HEVC')).toBe('h265');
      expect(normalizeDetectedCodec('mjpeg')).toBe('mjpeg');
      expect(normalizeDetectedCodec('mpeg4')).toBeNull();
      expect(normalizeDetectedCodec(undefined)).toBeNull();
    });
  });

  describe('detectedInfoToFormFields', () => {
    it('returns every detected value', () => {
      expect(detectedInfoToFormFields({ width: 1920, height: 1080, fps: 25, codec: 'hevc' }))
        .toEqual({ width: 1920, height: 1080, fps: 25, codec: 'h265' });
    });

    it('rounds fps', () => {
      expect(detectedInfoToFormFields({ fps: 29.97 }).fps).toBe(30);
    });

    it('omits values the probe could not detect', () => {
      expect(detectedInfoToFormFields({ width: 0, height: 0, fps: 0, codec: 'unknown' })).toEqual({});
      expect(detectedInfoToFormFields({ width: 1280, height: 0 })).toEqual({});
      expect(detectedInfoToFormFields(null)).toEqual({});
    });
  });

  describe('formatDetectedSummary', () => {
    it('joins the detected parts', () => {
      expect(formatDetectedSummary({ width: 1280, height: 720, fps: 12, codec: 'h264' }))
        .toBe('1280x720 · 12 fps · H.264');
      expect(formatDetectedSummary({ fps: 8 })).toBe('8 fps');
      expect(formatDetectedSummary({})).toBe('');
    });
  });
});
