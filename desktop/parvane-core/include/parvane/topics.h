// Parvane fork: зеркало топиков-констант из shared/parvane-types/src/lib.rs.
// Держать один-в-один с Rust-источником. Соглашение: {domain}.{resource}.{action}.
#pragma once

#include <string>

namespace parvane::topics {

// identity
inline constexpr auto IdentityIssue = "identity.token.issue";
inline constexpr auto IdentityRegister = "identity.user.register";
inline constexpr auto IdentityVerify = "identity.token.verify";

// messenger
inline constexpr auto MsgSend = "msg.chat.send";
inline constexpr auto MsgDelivered = "msg.chat.delivered";
inline constexpr auto MsgRead = "msg.chat.read";
inline constexpr auto MsgEdit = "msg.chat.edit";
inline constexpr auto MsgDelete = "msg.chat.delete";
inline constexpr auto MsgReact = "msg.chat.react";
inline constexpr auto MsgPin = "msg.chat.pin";
inline constexpr auto MsgAck = "msg.chat.ack";

// Персональный инбокс пользователя (msg.user.<addr>): входящие сообщения
// (InboxPush) и delivered-подтверждения. Зеркалит msg_inbox() из parvane-types.
inline std::string msgInbox(const std::string &user) { return "msg.user." + user; }
inline constexpr auto MsgSyncRequest = "msg.sync.request";
inline constexpr auto MsgSyncResponse = "msg.sync.response";

// cloud (медиа-блобы)
inline constexpr auto FileUploadChunk = "file.upload.chunk";
inline constexpr auto FileUploadComplete = "file.upload.complete";
inline constexpr auto FileDownloadRequest = "file.download.request";
inline constexpr auto FileDownloadResponse = "file.download.response";
inline constexpr auto FileListRequest = "file.list.request";
inline constexpr auto FileListResponse = "file.list.response";

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

// группы/каналы (request/reply на messenger)
inline constexpr auto GroupCreate = "group.create";
inline constexpr auto GroupAddMember = "group.addmember";
inline constexpr auto GroupRemoveMember = "group.removemember";
inline constexpr auto GroupList = "group.list";
inline constexpr auto GroupInfo = "group.info";

} // namespace parvane::topics
