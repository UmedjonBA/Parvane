import { describe, expect, it } from 'vitest';

import { pressAction } from './notesCanvasPress';

describe('pressAction', () => {
  it('пустое место вне групп двигает поле', () => {
    expect(pressAction({})).toEqual({ kind: 'board' });
  });

  it('пустое место внутри группы двигает поле: группу берут за шапку и границу (это её узел)', () => {
    expect(pressAction({})).toEqual({ kind: 'board' });
    expect(pressAction({ nodeId: 'g' })).toEqual({ kind: 'node', id: 'g' });
  });

  it('с Shift и в режиме выбора рисуется рамка выделения', () => {
    expect(pressAction({ isAdditive: true })).toEqual({ kind: 'marquee' });
  });

  it('средняя кнопка и пробел двигают поле и над группой, и над карточкой', () => {
    expect(pressAction({ isPanForced: true })).toEqual({ kind: 'pan' });
    expect(pressAction({ isPanForced: true, nodeId: 'n', handle: 'se' })).toEqual({ kind: 'pan' });
  });

  it('карточка внутри группы берётся сама', () => {
    expect(pressAction({ nodeId: 'card' })).toEqual({ kind: 'node', id: 'card' });
    expect(pressAction({ nodeId: 'card', isAdditive: true })).toEqual({ kind: 'node', id: 'card' });
  });

  it('ручка размера и точка стрелки старше сдвига узла', () => {
    expect(pressAction({ nodeId: 'g', handle: 'se' })).toEqual({ kind: 'resize', id: 'g', handle: 'se' });
    expect(pressAction({ nodeId: 'n', port: 'right' })).toEqual({ kind: 'arrow', id: 'n', side: 'right' });
    expect(pressAction({ nodeId: 'n', port: 'right', handle: 'e' })).toEqual({ kind: 'arrow', id: 'n', side: 'right' });
  });

  it('стрелка внутри группы выбирается, а не двигает группу', () => {
    expect(pressAction({ edgeId: 'e' })).toEqual({ kind: 'edge', id: 'e' });
    expect(pressAction({ edgeId: 'e', isAdditive: true })).toEqual({ kind: 'edge', id: 'e' });
  });

  it('в режиме «Связать» нажатие выбирает вторую карточку либо отменяет режим', () => {
    expect(pressAction({ isLinking: true, nodeId: 'n' })).toEqual({ kind: 'link', id: 'n' });
    expect(pressAction({ isLinking: true })).toEqual({ kind: 'link', id: undefined });
    expect(pressAction({ isLinking: true, nodeId: 'n', port: 'top' })).toEqual({ kind: 'arrow', id: 'n', side: 'top' });
  });
});
