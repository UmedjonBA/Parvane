// Parvane fork: зеркало топиков-констант из backend/shared/parvane-types/src/lib.rs.
// Держать один-в-один с Rust-источником. Соглашение: {domain}.{resource}.{action}.
#pragma once

#include <string>

namespace parvane::topics {

// identity
inline constexpr auto IdentityIssue = "identity.token.issue";
inline constexpr auto IdentityRegister = "identity.user.register";
inline constexpr auto IdentityVerify = "identity.token.verify";
inline constexpr auto IdentityPrekeysPublish = "identity.prekeys.publish";
inline constexpr auto IdentityPrekeysFetch = "identity.prekeys.fetch";
inline constexpr auto IdentityEmailConfirm = "identity.email.confirm";
inline constexpr auto IdentityDeviceList = "identity.device.list";
inline constexpr auto IdentityDeviceRevoke = "identity.device.revoke";
inline constexpr auto IdentityTwoFa = "identity.user.twofa";
inline constexpr auto IdentitySetKey = "identity.user.setkey";
inline constexpr auto IdentityPasswordChange = "identity.password.change";
inline constexpr auto IdentityLinkOffer = "identity.link.offer";
inline constexpr auto IdentityLinkPoll = "identity.link.poll";
inline constexpr auto IdentityLinkGrant = "identity.link.grant";
inline constexpr auto IdentityLinkChallenge = "identity.link.challenge";
inline constexpr auto IdentityServerInfo = "identity.server.info";
inline constexpr auto IdentityRegisterStatus = "identity.register.status";
inline constexpr auto IdentitySearch = "identity.user.search";
inline constexpr auto IdentitySetName = "identity.user.setname";
inline constexpr auto IdentitySetAvatar = "identity.user.setavatar";
inline constexpr auto IdentityResolve = "identity.user.resolve";

// messenger
inline constexpr auto MsgSend = "msg.chat.send";
inline constexpr auto MsgDelivered = "msg.chat.delivered";
inline constexpr auto MsgRead = "msg.chat.read";
inline constexpr auto MsgSetNotify = "msg.chat.setnotify"; // настройки уведомлений (кросс-девайс)
inline constexpr auto MsgEdit = "msg.chat.edit";
inline constexpr auto MsgDelete = "msg.chat.delete";
inline constexpr auto MsgClear = "msg.chat.clear"; // скрыть «для меня» (очистка/удаление чата)
inline constexpr auto MsgReact = "msg.chat.react";
inline constexpr auto MsgPin = "msg.chat.pin";
inline constexpr auto MsgReaders = "msg.chat.readers";
inline constexpr auto MsgAck = "msg.chat.ack";

// Персональный инбокс пользователя (msg.user.<addr>): входящие сообщения
// (InboxPush) и delivered-подтверждения. Зеркалит msg_inbox() из parvane-types.
inline std::string msgInbox(const std::string &user) { return "msg.user." + user; }
inline constexpr auto MsgSyncRequest = "msg.sync.request";
// Эфемерные субъекты (P-18): typing/presence по числовому id клиента. Зеркалят
// MSG_TYPING_PREFIX / PRESENCE_PREFIX и msg_typing()/presence() из parvane-types.
inline constexpr auto MsgTypingPrefix = "msg.typing.";
inline constexpr auto PresencePrefix = "presence.";
inline std::string msgTyping(const std::string &id) { return std::string(MsgTypingPrefix) + id; }
inline std::string presence(const std::string &id) { return std::string(PresencePrefix) + id; }
inline constexpr auto MsgSyncResponse = "msg.sync.response";

// cloud (медиа-блобы)
inline constexpr auto FileUploadChunk = "file.upload.chunk";
inline constexpr auto FileUploadComplete = "file.upload.complete";
inline constexpr auto FileDownloadRequest = "file.download.request";
inline constexpr auto FileDownloadResponse = "file.download.response";
inline constexpr auto FileListRequest = "file.list.request";
inline constexpr auto FileListResponse = "file.list.response";
inline constexpr auto FileDelete = "file.delete";

// notes
inline constexpr auto NoteCreate = "note.create";
inline constexpr auto NoteUpdate = "note.update";
inline constexpr auto NoteDelete = "note.delete";
inline constexpr auto NoteSyncRequest = "note.sync.request";
inline constexpr auto NoteSyncResponse = "note.sync.response";

// calendar
inline constexpr auto CalCreate = "cal.event.create";
inline constexpr auto CalUpdate = "cal.event.update";
inline constexpr auto CalDelete = "cal.event.delete";
inline constexpr auto CalSyncRequest = "cal.sync.request";
inline constexpr auto CalSyncResponse = "cal.sync.response";

// call
inline constexpr auto CallSignal = "call.signal";
inline constexpr auto CallHistoryRequest = "call.history.request";
inline constexpr auto CallHistoryResponse = "call.history.response";
inline constexpr auto CallIceRequest = "call.ice.request";
// Инбокс сигналов звонка call.user.<addr>; зеркалит call_inbox() из parvane-types.
inline std::string callInbox(const std::string &user) { return "call.user." + user; }
// Маршрут группового mesh-звонка в `to` сигнала (GROUP_CALL_ROUTE_PREFIX).
inline constexpr auto GroupCallRoutePrefix = "gcall:";
inline constexpr auto PreviewLinkFetch = "preview.link.fetch";
// OSM-тайл карты (Web Mercator z/x/y, PNG в base64) — для статичной карты в
// пузыре геолокации; наружу ходит шард preview, клиент к OSM не обращается
inline constexpr auto PreviewMapTile = "preview.map.tile";

// группы/каналы (request/reply на messenger)
inline constexpr auto GroupCreate = "group.create";
inline constexpr auto GroupAddMember = "group.addmember";
inline constexpr auto GroupRemoveMember = "group.removemember";
inline constexpr auto GroupSetRole = "group.setrole";
inline constexpr auto GroupList = "group.list";
inline constexpr auto GroupBan = "group.ban";
inline constexpr auto GroupUnban = "group.unban";
inline constexpr auto GroupMute = "group.mute";
inline constexpr auto GroupInviteCreate = "group.invite.create";
inline constexpr auto GroupJoin = "group.join";
inline constexpr auto GroupInfo = "group.info";
inline constexpr auto GroupRename = "group.rename";
inline constexpr auto GroupDelete = "group.delete";
// управление группой (spec 003): фото/описание, права, админы, ссылки, заявки
inline constexpr auto GroupSetInfo = "group.setinfo";
inline constexpr auto GroupSetPerms = "group.setperms";
inline constexpr auto GroupSetAdmin = "group.setadmin";
inline constexpr auto GroupInviteList = "group.invite.list";
inline constexpr auto GroupInviteRevoke = "group.invite.revoke";
inline constexpr auto GroupInviteDelete = "group.invite.delete";
inline constexpr auto GroupInviteCheck = "group.invite.check";
inline constexpr auto GroupRequestList = "group.request.list";
inline constexpr auto GroupRequestDecide = "group.request.decide";

} // namespace parvane::topics
