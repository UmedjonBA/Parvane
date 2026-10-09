import type { IconName } from '../types/icons';

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
