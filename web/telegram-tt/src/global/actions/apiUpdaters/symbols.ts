import type { ActionReturnType } from '../../types';

import { addActionHandler } from '../../index';
import { updateStickerSet } from '../../reducers';

addActionHandler('apiUpdate', (global, actions, update): ActionReturnType => {
  switch (update['@type']) {
    case 'updateStickerSet': {
      return updateStickerSet(global, update.id, update.stickerSet);
    }

    case 'updateSavedGifs': {
      actions.loadSavedGifs();
      return undefined;
    }

    // Избранные и недавние стикеры (Parvane: хранятся на устройстве, A6) — перечитать списки
    case 'updateFavoriteStickers': {
      actions.loadFavoriteStickers();
      return undefined;
    }

    case 'updateRecentStickers': {
      actions.loadRecentStickers();
      return undefined;
    }

    // Parvane: «Динамический порядок наборов» — набор отправленного стикера первым (B12)
    case 'updateMoveStickerSetToTop': {
      if (update.isCustomEmoji) return undefined;
      const setIds = global.stickers.added.setIds || [];
      if (!setIds.includes(update.id)) return undefined;
      return {
        ...global,
        stickers: {
          ...global.stickers,
          added: { ...global.stickers.added, setIds: [update.id, ...setIds.filter((id) => id !== update.id)] },
        },
      };
    }
  }

  return undefined;
});
