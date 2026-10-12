import type { IconName } from '../types/icons';

import airplaneIcon from '../assets/parvane/folder-icons/airplane.png';
import allIcon from '../assets/parvane/folder-icons/all.png';
import bookIcon from '../assets/parvane/folder-icons/book.png';
import botsIcon from '../assets/parvane/folder-icons/bots.png';
import catIcon from '../assets/parvane/folder-icons/cat.png';
import channelsIcon from '../assets/parvane/folder-icons/channels.png';
import crownIcon from '../assets/parvane/folder-icons/crown.png';
import customIcon from '../assets/parvane/folder-icons/custom.png';
import favoriteIcon from '../assets/parvane/folder-icons/favorite.png';
import flowerIcon from '../assets/parvane/folder-icons/flower.png';
import gameIcon from '../assets/parvane/folder-icons/game.png';
import groupIcon from '../assets/parvane/folder-icons/group.png';
import homeIcon from '../assets/parvane/folder-icons/home.png';
import lightIcon from '../assets/parvane/folder-icons/light.png';
import likeIcon from '../assets/parvane/folder-icons/like.png';
import loveIcon from '../assets/parvane/folder-icons/love.png';
import maskIcon from '../assets/parvane/folder-icons/mask.png';
import moneyIcon from '../assets/parvane/folder-icons/money.png';
import noteIcon from '../assets/parvane/folder-icons/note.png';
import paletteIcon from '../assets/parvane/folder-icons/palette.png';
import partyIcon from '../assets/parvane/folder-icons/party.png';
import privateIcon from '../assets/parvane/folder-icons/private.png';
import setupIcon from '../assets/parvane/folder-icons/setup.png';
import sportIcon from '../assets/parvane/folder-icons/sport.png';
import studyIcon from '../assets/parvane/folder-icons/study.png';
import tradeIcon from '../assets/parvane/folder-icons/trade.png';
import travelIcon from '../assets/parvane/folder-icons/travel.png';
import unmutedIcon from '../assets/parvane/folder-icons/unmuted.png';
import unreadIcon from '../assets/parvane/folder-icons/unread.png';
import workIcon from '../assets/parvane/folder-icons/work.png';

export const folderIconMap: Record<string, IconName> = {
  '🗂': 'folder-tabs-folder',
  '📁': 'folder-tabs-folder',
  '⭐': 'folder-tabs-star',
  '🤖': 'folder-tabs-bot',
  '👥': 'folder-tabs-group',
  '👤': 'folder-tabs-user',
  '✅': 'folder-tabs-chat',
  '📢': 'folder-tabs-channel',
  '💬': 'folder-tabs-chats',
};

export const emojiToFolderIcon = (emoji: string): IconName | undefined => {
  return folderIconMap[emoji];
};

// Parvane: набор значков папки Telegram Desktop (эмодзи-коды `ui/filter_icons` tdesktop, порядок его сетки).
// Значок хранится как `emoticon` папки — тем же полем его читает и desktop
export const FOLDER_ICON_EMOJIS = [
  '🐱', '📕', '💰', '🎮', '💡', '👍',
  '🎵', '🎨', '✈️', '⚽️', '⭐', '🎓',
  '🛫', '👤', '👥', '💬', '✅', '🤖',
  '👑', '🌹', '🏠', '❤️', '🎭', '🍸',
  '📈', '💼', '🔔', '📢', '📁', '📋',
];

// Значки папок Telegram Desktop (`Telegram/Resources/icons/folders`, GPL-3.0): одноцветные маски, красятся
// цветом текста. Ключ — эмодзи без селектора варианта (U+FE0F)
const FOLDER_ICON_IMAGES: Record<string, string> = {
  '🐱': catIcon,
  '📕': bookIcon,
  '💰': moneyIcon,
  '🎮': gameIcon,
  '💡': lightIcon,
  '👍': likeIcon,
  '🎵': noteIcon,
  '🎨': paletteIcon,
  '✈': travelIcon,
  '⚽': sportIcon,
  '⭐': favoriteIcon,
  '🎓': studyIcon,
  '🛫': airplaneIcon,
  '👤': privateIcon,
  '👥': groupIcon,
  '💬': allIcon,
  '✅': unreadIcon,
  '🤖': botsIcon,
  '👑': crownIcon,
  '🌹': flowerIcon,
  '🏠': homeIcon,
  '❤': loveIcon,
  '🎭': maskIcon,
  '🍸': partyIcon,
  '📈': tradeIcon,
  '💼': workIcon,
  '🔔': unmutedIcon,
  '📢': channelsIcon,
  '📁': customIcon,
  '📋': setupIcon,
  '👌': likeIcon,
  '🗂': customIcon,
};

const VARIATION_SELECTOR = /\uFE0F/g;

export function getFolderIconImage(emoji: string): string | undefined {
  return FOLDER_ICON_IMAGES[emoji.replace(VARIATION_SELECTOR, '')];
}
