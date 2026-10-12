import {
  beforeAll, describe, expect, it, vi,
} from 'vitest';
import type { FC } from '../lib/teact/teact';
import Teact from '../lib/teact/teact';
import TeactDOM from '../lib/teact/teact-dom';

// Записи истории экранов, которые живут всё время и только включаются и выключаются (правая колонка,
// экраны настроек). Случай из жизни: «Мой профиль» на телефоне закрыли кнопкой второй раз — запись в
// истории браузера оставалась, и «назад» из «Профиля» срабатывало со второго нажатия

vi.mock('../global', () => ({ getActions: () => ({ disableHistoryAnimations: () => undefined }) }));
vi.mock('../util/browser/windowEnvironment', () => ({ IS_IOS: false }));
// Счётчики истории хук отдаёт наружу только в тестовой сборке
vi.mock('../config', async (importOriginal) => ({ ...await importOriginal<object>(), IS_TEST: true }));

const SETTLE_MS = 80;

type Flags = { isProfileShown: boolean; isInfoShown: boolean };

let useHistoryBack: typeof import('./useHistoryBack').default;
let root: HTMLElement;
const onProfileBack = vi.fn();
const onInfoBack = vi.fn();

const settle = () => new Promise((resolve) => {
  setTimeout(resolve, SETTLE_MS);
});
const cursor = () => (window as unknown as { TEST_getHistoryCursor: () => number }).TEST_getHistoryCursor();
const realIndex = () => (window.history.state as { index: number }).index;

const Profile: FC<{ isActive: boolean }> = ({ isActive }) => {
  useHistoryBack({ isActive, onBack: onProfileBack });
  return undefined;
};
const Info: FC<{ isActive: boolean }> = ({ isActive }) => {
  useHistoryBack({ isActive, onBack: onInfoBack });
  return undefined;
};
const Screen: FC<Flags> = ({ isProfileShown, isInfoShown }) => Teact.createElement(
  'div', {},
  Teact.createElement(Profile, { isActive: isProfileShown }),
  Teact.createElement(Info, { isActive: isInfoShown }),
);

async function show(flags: Flags) {
  TeactDOM.render(Teact.createElement(Screen, flags) as Parameters<typeof TeactDOM.render>[0], root);
  await settle();
}

beforeAll(async () => {
  useHistoryBack = (await import('./useHistoryBack')).default;
  root = document.createElement('div');
  document.body.appendChild(root);
});

describe('useHistoryBack: экран, закрытый кнопкой повторно', () => {
  it('каждое закрытие кнопкой снимает запись, «назад» ведёт на шаг и с первого нажатия', async () => {
    await show({ isProfileShown: true, isInfoShown: false });
    expect(cursor()).toBe(1);

    // Открыт и закрыт кнопкой — дважды: вторая запись обязана уйти так же, как первая
    for (let round = 0; round < 2; round++) {
      await show({ isProfileShown: true, isInfoShown: true });
      expect(cursor()).toBe(2);
      expect(realIndex()).toBe(2);

      await show({ isProfileShown: true, isInfoShown: false });
      expect(cursor()).toBe(1);
      expect(realIndex()).toBe(1);
    }

    window.history.back();
    await settle();
    expect(onInfoBack).not.toHaveBeenCalled();
    expect(onProfileBack).toHaveBeenCalledTimes(1);
    expect(cursor()).toBe(0);
  });
});
