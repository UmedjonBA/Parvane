// @vitest-environment node
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import { pickNextCamera, switchCallCamera } from './callCameraSwitch';

function mockTrack(deviceId: string) {
  return {
    enabled: true,
    stop: vi.fn(),
    getSettings: () => ({ deviceId }),
  } as unknown as MediaStreamTrack;
}

function mockStream(track: MediaStreamTrack) {
  let tracks = [track];
  return {
    getVideoTracks: () => tracks,
    removeTrack: (item: MediaStreamTrack) => {
      tracks = tracks.filter((other) => other !== item);
    },
    addTrack: (item: MediaStreamTrack) => {
      tracks = [...tracks, item];
    },
  } as unknown as MediaStream;
}

function stubCameras(ids: string[]) {
  const fresh = mockTrack('');
  const getUserMedia = vi.fn(() => Promise.resolve({ getVideoTracks: () => [fresh] }));
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: () => Promise.resolve(ids.map((deviceId) => ({ kind: 'videoinput', deviceId }))),
      getUserMedia,
    },
  });
  return { fresh, getUserMedia };
}

describe('Смена камеры в звонке', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('берёт следующую камеру по кругу, одна камера — некуда', () => {
    expect(pickNextCamera(['front', 'back'], 'front')).toBe('back');
    expect(pickNextCamera(['front', 'back'], 'back')).toBe('front');
    expect(pickNextCamera(['front', 'back'])).toBe('front');
    expect(pickNextCamera(['front'], 'front')).toBeUndefined();
  });

  it('новый трек уходит отправителям и заменяет прежний в потоке', async () => {
    const { fresh, getUserMedia } = stubCameras(['front', 'back']);
    const current = mockTrack('front');
    current.enabled = false;
    const stream = mockStream(current);
    const replaceTrack = vi.fn(() => Promise.resolve());
    const isSwitched = await switchCallCamera(stream, [{ replaceTrack } as unknown as RTCRtpSender], false);
    expect(isSwitched).toBe(true);
    expect(getUserMedia).toHaveBeenCalledWith({ video: { deviceId: { exact: 'back' } } });
    expect(replaceTrack).toHaveBeenCalledWith(fresh);
    expect(stream.getVideoTracks()).toEqual([fresh]);
    expect(fresh.enabled).toBe(false);
    expect(current.stop).toHaveBeenCalled();
  });

  it('во время показа экрана отправители не трогаются', async () => {
    const { fresh } = stubCameras(['front', 'back']);
    const stream = mockStream(mockTrack('front'));
    const replaceTrack = vi.fn(() => Promise.resolve());
    await switchCallCamera(stream, [{ replaceTrack } as unknown as RTCRtpSender], true);
    expect(replaceTrack).not.toHaveBeenCalled();
    expect(stream.getVideoTracks()).toEqual([fresh]);
  });
});
