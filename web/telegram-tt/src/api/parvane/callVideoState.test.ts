// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { getIsCallVideoMuted } from './callVideoState';

describe('Состояние исходящего видео звонка', () => {
  it.each([
    ['голосовой звонок', false, undefined, false, true],
    ['камера включена', true, undefined, false, false],
    ['камера выключена', true, true, false, true],
    ['показ экрана без камеры', false, undefined, true, false],
    ['показ экрана с выключенной камерой', true, true, true, false],
  ] as const)('%s', (_name, hasCamera, isCameraOff, isSharingScreen, isMuted) => {
    expect(getIsCallVideoMuted({ hasCamera, isCameraOff, isSharingScreen })).toBe(isMuted);
  });
});
