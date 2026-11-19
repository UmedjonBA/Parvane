// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createCallAudioOutput } from './callAudioOutput';

function setupOutput() {
  const first = { setSinkId: vi.fn(async (_sinkId: string) => {}) };
  const second = { setSinkId: vi.fn(async (_sinkId: string) => {}) };
  const onSelecting = vi.fn();
  const onSelected = vi.fn();
  const onError = vi.fn();
  const routing = createCallAudioOutput({
    getPlayers: () => [first, second], onSelecting, onSelected, onError,
  });
  return {
    first, second, onSelected, onError, routing,
  };
}

describe('Вывод звука звонка', () => {
  it('переключает все плееры и сообщает о выборе после их ответа', async () => {
    const {
      first, second, onSelected, onError, routing,
    } = setupOutput();
    let finishSwitch!: () => void;
    second.setSinkId.mockReturnValueOnce(new Promise((resolve) => {
      finishSwitch = resolve;
    }));

    const pending = routing.chooseOutput('headset');
    expect(first.setSinkId).toHaveBeenCalledExactlyOnceWith('headset');
    expect(second.setSinkId).toHaveBeenCalledExactlyOnceWith('headset');
    expect(onSelected).not.toHaveBeenCalled();
    finishSwitch();
    await pending;
    expect(onSelected).toHaveBeenCalledExactlyOnceWith('headset');
    expect(onError).not.toHaveBeenCalled();
  });

  it('возвращает каждому плееру прежнее устройство при частичном отказе', async () => {
    const {
      first, second, onSelected, onError, routing,
    } = setupOutput();
    await routing.chooseOutput('headset');
    second.setSinkId.mockRejectedValueOnce(new DOMException('Устройство отключено', 'NotFoundError'));

    await routing.chooseOutput('speaker');

    expect(first.setSinkId.mock.calls).toEqual([['headset'], ['speaker'], ['headset']]);
    expect(second.setSinkId.mock.calls).toEqual([['headset'], ['speaker'], ['headset']]);
    expect(onSelected).toHaveBeenCalledExactlyOnceWith('headset');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('игнорирует ответ диалога от предыдущего звонка', async () => {
    const {
      first, second, onSelected, onError, routing,
    } = setupOutput();
    let deliverSink!: (value: string) => void;
    const stale = routing.chooseOutput(() => new Promise((resolve) => {
      deliverSink = resolve;
    }));

    routing.reset();
    await routing.chooseOutput('speaker');
    deliverSink('headset');
    await stale;

    expect(first.setSinkId).toHaveBeenCalledExactlyOnceWith('speaker');
    expect(second.setSinkId).toHaveBeenCalledExactlyOnceWith('speaker');
    expect(onSelected).toHaveBeenCalledExactlyOnceWith('speaker');
    expect(onError).not.toHaveBeenCalled();
  });

  it('не откатывает выбранный выход из-за позднего отказа от прошлого звонка', async () => {
    const {
      first, second, onSelected, onError, routing,
    } = setupOutput();
    let rejectOldSink!: (error: Error) => void;
    second.setSinkId.mockReturnValueOnce(new Promise((_resolve, reject) => {
      rejectOldSink = reject;
    }));
    const stale = routing.chooseOutput('headset');

    routing.reset();
    await routing.chooseOutput('speaker');
    rejectOldSink(new Error('Старый выход недоступен'));
    await stale;

    expect(first.setSinkId.mock.calls).toEqual([['headset'], ['speaker']]);
    expect(second.setSinkId.mock.calls).toEqual([['headset'], ['speaker']]);
    expect(onSelected).toHaveBeenCalledExactlyOnceWith('speaker');
    expect(onError).not.toHaveBeenCalled();
  });
});
