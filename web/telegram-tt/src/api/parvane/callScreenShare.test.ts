// @vitest-environment node
import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import { createCallScreenShare } from './callScreenShare';

function mockCapture() {
  const track = Object.assign(new EventTarget(), { readyState: 'live', stop: vi.fn() });
  track.stop.mockImplementation(() => {
    track.readyState = 'ended';
  });
  const stream = {
    getTracks: () => [track],
    getVideoTracks: () => [track],
  } as unknown as MediaStream;
  return { stream, track };
}

function mockSender() {
  const replaceTrack = vi.fn(async (_track?: MediaStreamTrack) => {});
  return { sender: { replaceTrack } as unknown as RTCRtpSender, replaceTrack };
}

function setupCall(hasCamera = false) {
  const { stream, track } = mockCapture();
  const { sender, replaceTrack } = mockSender();
  const camera = hasCamera ? (mockCapture().track as unknown as MediaStreamTrack) : undefined;
  const senders = [sender];
  const getDisplayMedia = vi.fn(() => Promise.resolve(stream));
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia } });

  const onChange = vi.fn();
  const onError = vi.fn();
  const sharing = createCallScreenShare({
    getSenders: () => senders,
    getCamera: () => camera,
    onChange,
    onError,
  });
  return {
    camera, stream, track, getDisplayMedia, senders, replaceTrack, sharing, onChange, onError,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('Показ экрана в звонке', () => {
  it('включает показ и останавливает его повторным нажатием', async () => {
    const {
      sharing, track, stream, getDisplayMedia, replaceTrack, onChange,
    } = setupCall();
    await sharing.toggle();
    expect(getDisplayMedia).toHaveBeenCalledWith({ video: true, audio: false });
    expect(replaceTrack).toHaveBeenCalledWith(track);
    expect(onChange).toHaveBeenNthCalledWith(1, stream);
    await sharing.toggle();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenNthCalledWith(2);
    expect(replaceTrack).toHaveBeenCalledOnce();
  });

  it('возвращает дорожку камеры после остановки', async () => {
    const { sharing, camera, replaceTrack } = setupCall(true);
    await sharing.toggle();
    await sharing.toggle();
    expect(replaceTrack).toHaveBeenNthCalledWith(2, camera);
  });

  it('завершает показ по событию ended от браузера', async () => {
    const {
      sharing, track, camera, replaceTrack, onChange,
    } = setupCall(true);
    await sharing.toggle();
    track.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(onChange).toHaveBeenNthCalledWith(2));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(replaceTrack).toHaveBeenLastCalledWith(camera);
  });

  it('откатывает показ у всех при отказе одного отправителя', async () => {
    const {
      sharing, track, camera, senders, replaceTrack, onChange, onError,
    } = setupCall(true);
    const other = mockSender();
    other.replaceTrack.mockRejectedValueOnce(new Error('Дорожка отклонена'));
    senders.push(other.sender);

    await sharing.toggle();

    expect(track.stop).toHaveBeenCalledOnce();
    expect(replaceTrack.mock.calls).toEqual([[track], [camera]]);
    expect(other.replaceTrack.mock.calls).toEqual([[track], [camera]]);
    expect(onChange.mock.calls).toEqual([[]]);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('не сообщает об ошибке при отмене диалога', async () => {
    const {
      sharing, getDisplayMedia, onError, onChange, replaceTrack,
    } = setupCall();
    getDisplayMedia.mockRejectedValueOnce(new DOMException('Действие отменено', 'NotAllowedError'));

    await sharing.toggle();

    expect(onError).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(replaceTrack).not.toHaveBeenCalled();
  });

  it('останавливает захват, вернувшийся после завершения звонка', async () => {
    const {
      sharing, track, stream, getDisplayMedia, onChange, onError, replaceTrack,
    } = setupCall();
    let deliverStream!: (value: MediaStream) => void;
    getDisplayMedia.mockReturnValueOnce(new Promise((resolve) => {
      deliverStream = resolve;
    }));
    const pending = sharing.toggle();

    sharing.reset();
    deliverStream(stream);
    await pending;

    expect(track.stop).toHaveBeenCalledOnce();
    expect(replaceTrack).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('игнорирует повторное нажатие, пока отправитель меняет дорожку', async () => {
    const {
      sharing, stream, track, replaceTrack, getDisplayMedia, onChange,
    } = setupCall();
    let finishReplacement!: () => void;
    replaceTrack.mockReturnValueOnce(new Promise((resolve) => {
      finishReplacement = resolve;
    }));
    const pending = sharing.toggle();
    await vi.waitFor(() => expect(replaceTrack).toHaveBeenCalledOnce());

    await sharing.toggle();
    expect(track.stop).not.toHaveBeenCalled();
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();

    finishReplacement();
    await pending;
    expect(onChange).toHaveBeenCalledExactlyOnceWith(stream);
  });

  it('подключает появившегося позже участника к текущему показу', async () => {
    const { sharing, track } = setupCall();
    const late = mockSender();

    expect(await sharing.attach(late.sender)).toBe(false);
    await sharing.toggle();
    expect(await sharing.attach(late.sender)).toBe(true);
    expect(late.replaceTrack).toHaveBeenCalledExactlyOnceWith(track);
    await sharing.toggle();
    expect(await sharing.attach(late.sender)).toBe(false);
    expect(late.replaceTrack).toHaveBeenCalledOnce();
  });
});
