// Синтез минимального ApiOldLangPack для старого lang-провайдера. Без него
// легаси-форматтеры дат (список чатов, «был(а) в сети») показывают голые ключи
// вида `Weekday.ShortMonday`. Имена дней/месяцев берём из Intl — без сети.

import type { ApiOldLangPack } from '../types';

const WEEKDAY_KEYS = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

const MONTH_KEYS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export function buildOldLangPack(langCode: string): ApiOldLangPack {
  const pack: ApiOldLangPack = {
    Cancel: 'Cancel',
    DialogPin: 'Pin',
    DialogUnpin: 'Unpin',
    Forward: 'Forward',
    PinMessageAlertChat: 'Do you want to pin this message for both participants?',
    PinMessageAlertTitle: 'Pin Message',
    UnreadMessages: 'Unread Messages',
    'Conversation.PinMessagesFor': 'Also pin for %@',
    'Weekday.Today': 'Today',
    'Weekday.Yesterday': 'Yesterday',
    formatDateAtTime: '%1$s at %2$s',
    'Time.TodayAt': 'today at %@',
    'Time.YesterdayAt': 'yesterday at %@',
    'Time.AtDate': '%@',
    'Time.JustNow': 'just now',
    'Time.MinutesAgo': { oneValue: '%@ minute ago', otherValue: '%@ minutes ago' },
    'StickerPack.AddStickerCount': { oneValue: 'Add %@ Sticker', otherValue: 'Add %@ Stickers' },
    'StickerPack.RemoveStickerCount': { oneValue: 'Remove %@ Sticker', otherValue: 'Remove %@ Stickers' },
    SETTINGS: 'Settings',
    lng_settings_information: 'Edit profile',
    FirstName: 'First name (required)',
    LastName: 'Last name (optional)',
    UserBio: 'Bio (optional)',
    Save: 'Save',
    Username: 'Username',
    UsernameHelp: 'Usernames are not supported on this server yet.',
    lng_settings_about_bio: 'Any details such as age, occupation or city.',
    LogOutTitle: 'Log Out',
    'Common.Select': 'Select',
    'Chat.ForwardActionHeader': 'Forward',
    'AttachmentMenu.PhotoOrVideo': 'Photo or Video',
    AttachDocument: 'Document',
    lng_context_remove_from_group: 'Remove from group',
    'GroupRemoved.Remove': 'Remove user',
    'PeerInfo.Confirm.RemovePeer': 'Remove %@ from the group?',
    lng_box_remove: 'Remove',
    lng_channel_add_users: 'Add members',
    Online: 'online',
    Lately: 'last seen recently',
    'LastSeen.JustNow': 'last seen just now',
    'LastSeen.MinutesAgo': { oneValue: 'last seen %@ minute ago', otherValue: 'last seen %@ minutes ago' },
    'LastSeen.HoursAgo': { oneValue: 'last seen %@ hour ago', otherValue: 'last seen %@ hours ago' },
    'LastSeen.TodayAt': 'last seen today at %@',
    'LastSeen.YesterdayAt': 'last seen yesterday at %@',
    'LastSeen.AtDate': 'last seen %@',
    ScheduleMessage: 'Schedule Message',
    SendWithoutSound: 'Send Without Sound',
    'Conversation.ScheduleMessage.SendToday': 'Send today at %@',
    'Conversation.ScheduleMessage.SendOn': 'Send on %@ at %@',
    BlockedUsers: 'Blocked Users',
    SendMessage: 'Send Message',
    NewMessageTitle: 'New Message',
    GroupAddMembers: 'Add Members',
    Emoji: 'Emoji',
    AccDescrStickers: 'Stickers',
    GifsTab: 'GIFs',
    'StickersList.EmojiItem': 'Custom Emoji',
    Call: 'Call',
    CallAccept: 'Accept',
    CallEndCall: 'End Call',
    CallStatusRequesting: 'requesting...',
    CallStatusRinging: 'ringing...',
    CallStatusIncoming: 'is calling you...',
    CallStatusExchanging: 'exchanging encryption keys...',
    ParvaneCallSecurityError: 'Call security check failed',
    CallEmojiKeyTooltip: 'If these emoji match what %@ sees, this call is fully secure',
    lng_polls_stop: 'Stop poll',
    lng_polls_stop_warning: 'If you stop this poll now, nobody will be able to vote in it anymore',
    lng_polls_stop_sure: 'Stop poll',
    GroupName: 'Group name',
    EnterChannelName: 'Channel name',
    'GroupInfo.ParticipantCount': { oneValue: '%@ member', otherValue: '%@ members' },
    lng_info_user_title: 'User Info',
    lng_info_group_title: 'Group Info',
    'GroupInfo.Title': 'Group Info',
    BlockedUsersInfo: 'Blocked users cannot send you messages',
    NoBlocked: 'No blocked users yet',
    BlockContact: 'Block',
    Unblock: 'Unblock',
    'SharedMedia.EmptyTitle': 'No shared media yet',
    NewGroup: 'New Group',
    NewChannel: 'New Channel',
    Close: 'Close',
    lng_sure_logout: 'Are you sure you want to log out?',
    'AccountSettings.Logout': 'Log Out',
    AccDescrGoBack: 'Go back',
  };

  const longWeekday = new Intl.DateTimeFormat(langCode, { weekday: 'long' });
  const shortWeekday = new Intl.DateTimeFormat(langCode, { weekday: 'short' });
  // 2024-09-01 — воскресенье; идём по дням недели от него
  WEEKDAY_KEYS.forEach((key, day) => {
    const date = new Date(Date.UTC(2024, 8, 1 + day, 12));
    pack[`Weekday.${key}`] = longWeekday.format(date);
    pack[`Weekday.Short${key}`] = shortWeekday.format(date);
  });

  const longMonth = new Intl.DateTimeFormat(langCode, { month: 'long' });
  const shortMonth = new Intl.DateTimeFormat(langCode, { month: 'short' });
  MONTH_KEYS.forEach((key, month) => {
    const date = new Date(Date.UTC(2024, month, 15, 12));
    pack[`Month.${key}`] = longMonth.format(date);
    pack[`Month.Short${key}`] = shortMonth.format(date);
    pack[`Month.Gen${key}`] = longMonth.format(date);
  });

  return pack;
}
