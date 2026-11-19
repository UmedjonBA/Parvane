import { expect, it, vi } from 'vitest';
import Teact, { captureImmediateEffects } from '../../../../lib/teact/teact';
import TeactDOM from '../../../../lib/teact/teact-dom';

import type { ApiDraft } from '../../../../api/types';

import { createSignal } from '../../../../util/signals';
import useDraft from './useDraft';

vi.mock('../../../../global', () => ({ getActions: () => ({ clearDraft: vi.fn(), saveDraft: vi.fn() }) }));
vi.mock('../../../../util/browser/windowEnvironment', () => ({ IS_TOUCH_ENV: false, IS_EMOJI_SUPPORTED: true }));
vi.mock('../../../common/helpers/renderTextWithEntities', () => ({
  getTextWithEntitiesAsHtml: (text?: { text: string }) => text?.text || '',
}));

it('не восстанавливает отправленный текст до получения обновлённого черновика', () => {
  const draft = { text: { text: 'Бумажный фонарь' }, isLocal: true };
  const [getHtml, setHtml] = createSignal('');
  const root = document.createElement('div');

  function Composer({ savedDraft }: { savedDraft?: ApiDraft }) {
    useDraft({ chatId: '42', threadId: -1, draft: savedDraft, getHtml, setHtml });
    return undefined;
  }

  try {
    TeactDOM.render(Teact.createElement(Composer, { savedDraft: draft }), root);
    expect(getHtml()).toBe(draft.text.text);

    // Композер очищает поле в фазе измерения, пока проп ещё содержит отправленный черновик
    const runLayoutEffects = captureImmediateEffects()!;
    setHtml('');
    runLayoutEffects();
    expect(getHtml()).toBe('');

    TeactDOM.render(Teact.createElement(Composer, {}), root);
    expect(getHtml()).toBe('');
  } finally {
    TeactDOM.render(undefined, root);
  }
});
