import { afterEach, expect, it, vi } from 'vitest';
import Teact, { captureImmediateEffects, type VirtualElementComponent } from '../../../../lib/teact/teact';
import TeactDOM from '../../../../lib/teact/teact-dom';

import type { ApiDraft } from '../../../../api/types';

import { requestNextMutation } from '../../../../lib/fasterdom/fasterdom';
import { createSignal } from '../../../../util/signals';
import useDraft from './useDraft';

vi.mock('../../../../global', () => ({ getActions: () => ({ clearDraft: vi.fn(), saveDraft: vi.fn() }) }));
vi.mock('../../../../util/parseHtmlAsFormattedText', () => ({ default: (text: string) => ({ text }) }));
vi.mock('../../../../util/browser/windowEnvironment', () => ({ IS_TOUCH_ENV: false, IS_EMOJI_SUPPORTED: true }));
vi.mock('../../../common/helpers/renderTextWithEntities', () => ({
  getTextWithEntitiesAsHtml: (text?: { text: string }) => text?.text || '',
}));

const TEXT = 'Бумажный фонарь';
const root = document.createElement('div');

function mountComposer() {
  const [getHtml, setHtml] = createSignal('');

  function Composer({ draft }: { draft?: ApiDraft }) {
    useDraft({ chatId: '42', threadId: -1, draft, getHtml, setHtml });
    return undefined;
  }

  function renderComposer(draft?: ApiDraft) {
    const element = Teact.createElement(Composer, { draft }) as VirtualElementComponent;
    TeactDOM.render(element, root);
  }

  return { getHtml, setHtml, renderComposer };
}

function waitForFrame() {
  return new Promise<void>((resolve) => {
    requestNextMutation(resolve);
  });
}

afterEach(async () => {
  TeactDOM.render(undefined, root);
  // Отложенные кадры отрисовки должны отработать до снятия окружения теста
  await waitForFrame();
  await waitForFrame();
});

it('не восстанавливает отправленный текст до получения обновлённого черновика', () => {
  const { getHtml, setHtml, renderComposer } = mountComposer();
  renderComposer({ text: { text: TEXT }, isLocal: true });
  expect(getHtml()).toBe(TEXT);

  // Композер очищает поле в фазе измерения, пока проп ещё содержит отправленный черновик
  const runLayoutEffects = captureImmediateEffects()!;
  setHtml('');
  runLayoutEffects();
  expect(getHtml()).toBe('');

  renderComposer();
  expect(getHtml()).toBe('');
});

it.each([
  { edit: undefined, expected: '' },
  { edit: 'Другой фонарь', expected: 'Другой фонарь' },
])('применяет удаление с другого устройства с учётом правки поля $edit', async ({ edit, expected }) => {
  const { getHtml, setHtml, renderComposer } = mountComposer();
  renderComposer({ text: { text: TEXT }, isLocal: true });
  await waitForFrame();
  renderComposer({ text: { text: TEXT }, isLocal: false });
  await waitForFrame();
  if (edit) {
    setHtml(edit);
    await waitForFrame();
  }

  renderComposer();
  expect(getHtml()).toBe(expected);
});
