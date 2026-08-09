import type { SendMessageParams } from '../../types';
import type {
  ApiChat, ApiMessage, ApiOnProgress, ApiSticker, ApiUpdate, ApiUser, ApiVideo,
} from '../types';
import type { E2eEngine } from './e2e';
import type { GatewayConnection } from './gateway';
import type { createLocalState } from './localState';
import type { createMediaService } from './media';
import type { PollStore } from './polls';
import type { ParvaneStore } from './store';
import type { createSyncController } from './sync';

import {
  deliverToEveryGroupMember,
  E2E_SEND_ERROR,
  getActiveGroupMemberAddresses,
  requireE2e,
  requireEncrypted,
} from './e2eSendPolicy';
import { apiEntitiesToWire } from './entities';
import {
  buildWireEvent,
  TOPIC_MSG_DELETE,
  TOPIC_MSG_EDIT,
  TOPIC_MSG_PIN,
  TOPIC_MSG_REACT,
  TOPIC_MSG_READ,
  TOPIC_MSG_SEND,
  TOPIC_PREKEYS_FETCH,
  type WireMessageContent,
} from './wire';

type MessageDependencies = {
  getConnection: () => GatewayConnection | undefined;
  getE2e: () => E2eEngine | undefined;
  getStore: () => ParvaneStore;
  getToken: () => string;
  localState: ReturnType<typeof createLocalState>;
  media: ReturnType<typeof createMediaService>;
  polls: PollStore;
  sync: ReturnType<typeof createSyncController>;
  selfId: () => string;
  sendUpdate: (update: ApiUpdate) => void;
  collectUsersFor: (messages: ApiMessage[]) => ApiUser[];
  log: (message: string) => void;
};

export function createMessageController(deps: MessageDependencies) {
  const uuidBySentLocalKey = new Map<string, string>();
  const savedGifs: ApiVideo[] = [];

  const connection = () => deps.getConnection();
  const store = () => deps.getStore();
  const token = () => deps.getToken();

  async function fetchPrekeyBundle(user: string) {
    const raw = await connection()!.request(TOPIC_PREKEYS_FETCH, JSON.stringify({ token: token(), user }));
    return JSON.parse(raw) as {
      ok: boolean; identity_key?: string; signed_prekey?: string; one_time?: string;
    };
  }

  async function distributeGroupKey(group: string, members: string[]) {
    const engine = requireE2e(deps.getE2e());
    const currentStore = store();
    engine.syncGroupRecipients(group, members, currentStore.self);
    const { sessionKey, epoch } = engine.getGroupSessionKey(group);
    const content = {
      kind: 'skdm', group, session_key: sessionKey, sender_identity: engine.identityKey, epoch,
    };
    const innerJson = JSON.stringify({ from: currentStore.self, content });

    await deliverToEveryGroupMember(members, currentStore.self, async (member) => {
      const encrypted = await engine.encryptFor(member, innerJson, fetchPrekeyBundle);
      if (!encrypted) return false;
      connection()!.publish(TOPIC_MSG_SEND, JSON.stringify({
        id: crypto.randomUUID(),
        from: '',
        ts: Math.floor(Date.now() / 1000),
        token: token(),
        payload: {
          to: member,
          content: {
            kind: 'encrypted',
            ciphertext: encrypted.ciphertext,
            ctype: encrypted.ctype,
            sender_identity: encrypted.sender_identity,
            sender_signing_key: engine.signingKey,
          },
        },
      }));
      return true;
    });
    return epoch;
  }

  async function publishInner(
    toAddress: string,
    wireContent: Record<string, unknown>,
    uuid = crypto.randomUUID(),
  ) {
    const currentStore = store();
    const ts = Math.floor(Date.now() / 1000);
    const engine = requireE2e(deps.getE2e());
    const groupInfo = currentStore.getGroupInfo(toAddress);

    if (groupInfo) {
      const groupEpoch = await distributeGroupKey(
        toAddress,
        getActiveGroupMemberAddresses(groupInfo.members),
      );
      const ciphertext = requireEncrypted(
        await engine.groupEncrypt(toAddress, JSON.stringify(wireContent), groupEpoch),
        `Group encryption failed for ${toAddress}.`,
      );
      connection()!.publish(TOPIC_MSG_SEND, JSON.stringify({
        id: uuid,
        from: currentStore.self,
        ts,
        token: token(),
        payload: {
          to: toAddress,
          content: {
            kind: 'group_encrypted', ciphertext, group: toAddress, sender_identity: engine.identityKey,
            sender_signing_key: engine.signingKey,
          },
        },
      }));
      deps.localState.appendOwnJournal({
        id: uuid, from: currentStore.self, to: toAddress, content: wireContent as never, ts,
      });
      engine.cacheInner(uuid, { from: currentStore.self, content: wireContent });
      return uuid;
    }

    const inner = JSON.stringify({ from: currentStore.self, content: wireContent });
    const encrypted = requireEncrypted(
      await engine.encryptFor(toAddress, inner, fetchPrekeyBundle),
      `No usable prekey/session for ${toAddress}.`,
    );
    connection()!.publish(TOPIC_MSG_SEND, JSON.stringify({
      id: uuid,
      from: '',
      ts,
      token: token(),
      payload: {
        to: toAddress,
        content: {
          kind: 'encrypted',
          ciphertext: encrypted.ciphertext,
          ctype: encrypted.ctype,
          sender_identity: encrypted.sender_identity,
          sender_signing_key: engine.signingKey,
        },
      },
    }));
    deps.localState.appendOwnJournal({
      id: uuid, from: currentStore.self, to: toAddress, content: wireContent as never, ts,
    });
    engine.cacheInner(uuid, { from: currentStore.self, content: wireContent });
    return uuid;
  }

  function rememberSavedGif(gif: ApiVideo) {
    if (!savedGifs.some((candidate) => candidate.id === gif.id)) savedGifs.unshift(gif);
  }

  async function sendGif(chat: ApiChat, gif: ApiVideo) {
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;
    requireE2e(deps.getE2e());
    const cached = await deps.media.getCached(gif.id);
    const blob = cached?.blob || (
      gif.blobUrl ? await fetch(gif.blobUrl).then((response) => response.blob()) : undefined
    );
    if (!blob) return;
    const { fileId, mediaKeys } = await deps.media.uploadBlob(blob, `${gif.id}.webm`, 'video/webm', {
      encrypt: true,
      recipients: deps.media.getCloudRecipients(toAddress),
    });
    const mediaCrypto = mediaKeys ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64 } : {};
    const wireContent: Record<string, unknown> = {
      kind: 'gif',
      file_id: fileId,
      filename: `${gif.id}.webm`,
      mime: 'video/webm',
      width: gif.width || 240,
      height: gif.height || 240,
      duration_secs: Math.round(gif.duration),
      size_bytes: blob.size,
      ...mediaCrypto,
    };
    deps.media.cacheBlob(fileId, blob, 'video/webm');
    const uuid = await publishInner(toAddress, wireContent);
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const sentGif = { ...gif, id: fileId };
    rememberSavedGif(sentGif);
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: { video: sentGif },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: deps.selfId(),
    };
    currentStore.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
  }

  async function sendSticker(chat: ApiChat, sticker: ApiSticker) {
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;
    requireE2e(deps.getE2e());
    const cached = await deps.media.getCached(sticker.id);
    const blob = cached?.blob;
    if (!blob) return;
    const mime = cached.mimeType || 'image/png';
    const extension = mime === 'video/webm' ? 'webm' : 'png';
    const { fileId, mediaKeys } = await deps.media.uploadBlob(
      blob,
      `sticker-${sticker.id}.${extension}`,
      mime,
      { encrypt: true, recipients: deps.media.getCloudRecipients(toAddress) },
    );
    const mediaCrypto = mediaKeys ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64 } : {};
    const wireContent: Record<string, unknown> = {
      kind: 'sticker',
      file_id: fileId,
      filename: sticker.emoji || '⭐',
      mime,
      width: sticker.width || 256,
      height: sticker.height || 256,
      ...mediaCrypto,
    };
    deps.media.cacheBlob(fileId, blob, mime);
    const uuid = await publishInner(toAddress, wireContent);
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: { sticker: { ...sticker, id: fileId } },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: deps.selfId(),
    };
    currentStore.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
  }

  function refreshPollMessage(uuid: string) {
    const chatId = deps.polls.getChatId(uuid);
    if (!chatId) return;
    const currentStore = store();
    const messageId = currentStore.allocateMessageId(chatId, uuid);
    const poll = deps.polls.build(uuid);
    const message = currentStore.getMessages(chatId).find((candidate) => candidate.id === messageId);
    if (poll && message) {
      deps.sendUpdate({ '@type': 'updateMessage', chatId, id: messageId, isFull: true, message, poll });
    }
  }

  async function sendPoll(chat: ApiChat, newPoll: {
    summary: {
      question: { text: string };
      answers: { text: { text: string } }[];
      isPublic?: true;
      isMultipleChoice?: true;
    };
  }) {
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;
    const question = newPoll.summary.question.text;
    const options = newPoll.summary.answers.map((answer) => answer.text.text);
    const uuid = crypto.randomUUID();
    deps.polls.register(uuid, chat.id, question, options, {
      isPublic: Boolean(newPoll.summary.isPublic),
      isMultiple: Boolean(newPoll.summary.isMultipleChoice),
    });
    await publishInner(toAddress, {
      kind: 'poll',
      question,
      options,
      is_public: newPoll.summary.isPublic || undefined,
      is_multiple: newPoll.summary.isMultipleChoice || undefined,
    }, uuid);
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: { pollId: uuid },
      date: Math.floor(Date.now() / 1000),
      isOutgoing: true,
      senderId: deps.selfId(),
    };
    currentStore.putMessage(message);
    deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message, poll: deps.polls.build(uuid) });
  }

  function reportEncryptionSendFailure(chatId: string, localId: number, detail?: unknown) {
    const detailMessage = detail instanceof Error ? detail.message : '';
    deps.log(`${E2E_SEND_ERROR}${detailMessage ? ` ${detailMessage}` : ''}`);
    deps.sendUpdate({
      '@type': 'updateMessageSendFailed', chatId, localId, error: E2E_SEND_ERROR,
    });
  }

  function sendMessageLocal(params: SendMessageParams) {
    const { chat, replyInfo } = params;
    if (!chat) return Promise.resolve(undefined);
    const currentStore = store();
    const uuid = crypto.randomUUID();
    const id = currentStore.allocateMessageId(chat.id, uuid);
    const replyToMsgId = replyInfo?.type === 'message' ? replyInfo.replyToMsgId : undefined;
    const message: ApiMessage = {
      id,
      chatId: chat.id,
      content: deps.media.buildLocalContent(uuid, params),
      date: Math.floor(Date.now() / 1000),
      isForwardingAllowed: true,
      isOutgoing: true,
      senderId: deps.selfId(),
      sendingState: 'messageSendingStatePending',
      replyInfo: replyToMsgId ? { type: 'message', replyToMsgId } : undefined,
    };
    uuidBySentLocalKey.set(`${chat.id}:${id}`, uuid);
    deps.sendUpdate({
      '@type': 'newMessage', chatId: chat.id, id, message, wasDrafted: params.wasDrafted,
    });
    return Promise.resolve(message);
  }

  async function sendMessage(params: SendMessageParams, _onProgress?: ApiOnProgress) {
    if (params.scheduledAt && params.chat) {
      deps.localState.scheduleMessage(params);
      return;
    }
    if (params.poll && params.chat) {
      await sendPoll(params.chat, params.poll);
      return;
    }
    if (params.sticker && params.chat) {
      await sendSticker(params.chat, params.sticker);
      return;
    }
    if (params.gif && params.chat) {
      await sendGif(params.chat, params.gif);
      return;
    }

    const localMessage = params.localMessage || await sendMessageLocal(params);
    const { chat, attachment } = params;
    if (!localMessage || !chat) return;
    const currentStore = store();
    const toAddress = currentStore.getAddressForId(chat.id);
    if (!toAddress) return;

    let engine: E2eEngine;
    try {
      engine = requireE2e(deps.getE2e());
    } catch (error) {
      reportEncryptionSendFailure(chat.id, localMessage.id, error);
      return;
    }

    const uuid = uuidBySentLocalKey.get(`${chat.id}:${localMessage.id}`) || crypto.randomUUID();
    const replyToMsgId = params.replyInfo?.type === 'message' ? params.replyInfo.replyToMsgId : undefined;
    const replyToUuid = replyToMsgId ? currentStore.getUuidForMessage(chat.id, replyToMsgId) : undefined;
    const ttlSecs = deps.localState.loadPeerTtl()[toAddress];
    let wireContent: Record<string, unknown> = {
      kind: 'text',
      text: params.text || '',
      entities: apiEntitiesToWire(params.entities),
      webpage: params.noWebPage ? undefined : deps.media.detectWebPage(params.text),
      ttl_secs: ttlSecs || undefined,
    };
    let sentContent = localMessage.content;
    if (attachment) {
      try {
        const blob: Blob = attachment.blob ?? await fetch(attachment.blobUrl).then((response) => response.blob());
        // Local echo играет/скачивает по id локального uuid; кэшируем блоб под
        // ним до аплоада, иначе обращение до/после подмены контента упирается в
        // несуществующий file_id (у voice плеер фиксирует audio.src навсегда)
        deps.media.cacheBlob(uuid, blob, attachment.mimeType || 'application/octet-stream');
        const { fileId, size, mediaKeys } = await deps.media.uploadBlob(
          blob,
          attachment.filename,
          attachment.mimeType,
          { encrypt: true, recipients: deps.media.getCloudRecipients(toAddress) },
        );
        const mediaCrypto = mediaKeys ? { file_key: mediaKeys.keyB64, file_nonce: mediaKeys.nonceB64 } : {};
        if (attachment.voice) {
          wireContent = {
            kind: 'voice',
            file_id: fileId,
            duration_secs: Math.max(1, Math.round(attachment.voice.duration)),
            mime: attachment.mimeType || 'audio/ogg',
            size_bytes: size,
            waveform: attachment.voice.waveform,
            ...mediaCrypto,
          };
          sentContent = {
            voice: {
              mediaType: 'voice',
              id: fileId,
              duration: attachment.voice.duration,
              waveform: attachment.voice.waveform,
              size,
            },
          };
        } else if (attachment.isRoundVideo || deps.media.isVideoAttachment(attachment)) {
          const isRound = Boolean(attachment.isRoundVideo);
          const quick = attachment.quick;
          wireContent = {
            kind: isRound ? 'video_note' : 'video',
            file_id: fileId,
            duration_secs: Math.max(1, Math.round(quick?.duration || 1)),
            width: quick?.width || (isRound ? 384 : 640),
            height: quick?.height || (isRound ? 384 : 480),
            mime: attachment.mimeType,
            size_bytes: size,
            caption: isRound ? undefined : params.text || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text && !isRound ? { text: { text: params.text } } : {}),
            video: {
              mediaType: 'video',
              id: fileId,
              isRound: isRound || undefined,
              mimeType: attachment.mimeType,
              duration: quick?.duration || 1,
              fileName: attachment.filename,
              width: quick?.width,
              height: quick?.height,
              size,
              blobUrl: attachment.blobUrl,
              previewBlobUrl: attachment.previewBlobUrl,
            },
          };
        } else if (attachment.audio) {
          wireContent = {
            kind: 'file',
            file_id: fileId,
            filename: attachment.filename,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            duration_secs: Math.round(attachment.audio.duration) || undefined,
            audio_title: attachment.audio.title,
            audio_performer: attachment.audio.performer,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            audio: {
              mediaType: 'audio',
              id: fileId,
              size,
              mimeType: attachment.mimeType,
              fileName: attachment.filename,
              duration: attachment.audio.duration,
              title: attachment.audio.title,
              performer: attachment.audio.performer,
            },
          };
        } else if (deps.media.isPhotoAttachment(attachment)) {
          wireContent = {
            kind: 'photo',
            file_id: fileId,
            width: attachment.quick!.width,
            height: attachment.quick!.height,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            photo: {
              mediaType: 'photo',
              id: fileId,
              date: localMessage.date,
              blobUrl: attachment.blobUrl,
              sizes: [
                { type: 'x', width: attachment.quick!.width, height: attachment.quick!.height },
                { type: 'y', width: attachment.quick!.width, height: attachment.quick!.height },
              ],
            },
          };
        } else {
          wireContent = {
            kind: 'file',
            file_id: fileId,
            filename: attachment.filename,
            mime: attachment.mimeType,
            size_bytes: size,
            caption: params.text || undefined,
            ...mediaCrypto,
          };
          sentContent = {
            ...(params.text ? { text: { text: params.text } } : {}),
            document: {
              mediaType: 'document',
              id: fileId,
              fileName: attachment.filename,
              size,
              mimeType: attachment.mimeType,
              timestamp: localMessage.date,
            },
          };
        }
      } catch (error) {
        deps.log(`загрузка вложения не удалась: ${String(error)}`);
        deps.sendUpdate({
          '@type': 'updateMessageSendFailed', chatId: chat.id, localId: localMessage.id, error: 'Upload failed',
        });
        return;
      }
    }

    const groupInfo = currentStore.getGroupInfo(toAddress);
    if (groupInfo) {
      try {
        const groupEpoch = await distributeGroupKey(
          toAddress,
          getActiveGroupMemberAddresses(groupInfo.members),
        );
        const ciphertext = requireEncrypted(
          await engine.groupEncrypt(toAddress, JSON.stringify(wireContent), groupEpoch),
          `Group encryption failed for ${toAddress}.`,
        );
        const ts = Math.floor(Date.now() / 1000);
        connection()!.publish(TOPIC_MSG_SEND, JSON.stringify({
          id: uuid,
          from: currentStore.self,
          ts,
          token: token(),
          payload: {
            to: toAddress,
            content: {
              kind: 'group_encrypted', ciphertext, group: toAddress, sender_identity: engine.identityKey,
              sender_signing_key: engine.signingKey,
            },
            reply_to: replyToUuid,
          },
        }));
        deps.localState.appendOwnJournal({
          id: uuid,
          from: currentStore.self,
          to: toAddress,
          content: wireContent as unknown as WireMessageContent,
          ts,
          reply_to: replyToUuid,
        });
        engine.cacheInner(uuid, { from: currentStore.self, content: wireContent });
        const sentMessage: ApiMessage = { ...localMessage, sendingState: undefined };
        currentStore.putMessage(sentMessage);
        deps.sendUpdate({
          '@type': 'updateMessageSendSucceeded', chatId: chat.id, localId: localMessage.id, message: sentMessage,
        });
        return;
      } catch (error) {
        reportEncryptionSendFailure(chat.id, localMessage.id, error);
        return;
      }
    }

    const plainContent = wireContent;
    try {
      const innerJson = JSON.stringify({ from: currentStore.self, content: wireContent });
      const encrypted = requireEncrypted(
        await engine.encryptFor(toAddress, innerJson, fetchPrekeyBundle),
        `No usable prekey/session for ${toAddress}.`,
      );
      wireContent = {
        kind: 'encrypted',
        ciphertext: encrypted.ciphertext,
        ctype: encrypted.ctype,
        sender_identity: encrypted.sender_identity,
        sender_signing_key: engine.signingKey,
      };
    } catch (error) {
      reportEncryptionSendFailure(chat.id, localMessage.id, error);
      return;
    }

    const ts = Math.floor(Date.now() / 1000);
    connection()!.publish(TOPIC_MSG_SEND, JSON.stringify({
      id: uuid,
      from: '',
      ts,
      token: token(),
      payload: { to: toAddress, content: wireContent, reply_to: replyToUuid },
    }));
    if (!ttlSecs) {
      deps.localState.appendOwnJournal({
        id: uuid,
        from: currentStore.self,
        to: toAddress,
        content: plainContent as unknown as WireMessageContent,
        ts,
        reply_to: replyToUuid,
      });
      engine.cacheInner(uuid, { from: currentStore.self, content: plainContent });
    }
    const sentMessage: ApiMessage = { ...localMessage, content: sentContent, sendingState: undefined };
    currentStore.putMessage(sentMessage);
    deps.sendUpdate({
      '@type': 'updateMessageSendSucceeded',
      chatId: chat.id,
      localId: localMessage.id,
      message: sentMessage,
    });
    if (ttlSecs) deps.localState.scheduleTtlDeletion(chat.id, localMessage.id, ttlSecs);
  }

  const methods = {
    fetchMessagesById({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
      const byId = new Map(store().getMessages(chat.id).map((message) => [message.id, message]));
      return Promise.resolve(messageIds.map((id) => byId.get(id)).filter(Boolean));
    },

    async editMessage({ chat, message, text }: { chat: ApiChat; message: ApiMessage; text: string }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, message.id);
      const activeConnection = connection();
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!uuid || !activeConnection || !toAddress) return undefined;

      const engine = requireE2e(deps.getE2e());
      const plainContent = { kind: 'text', text, entities: [] };
      let encryptedContent: WireMessageContent;
      const groupInfo = currentStore.getGroupInfo(toAddress);
      if (groupInfo) {
        const epoch = await distributeGroupKey(
          toAddress,
          getActiveGroupMemberAddresses(groupInfo.members),
        );
        const ciphertext = requireEncrypted(
          await engine.groupEncrypt(toAddress, JSON.stringify(plainContent), epoch),
          `Group encryption failed for ${toAddress}.`,
        );
        encryptedContent = {
          kind: 'group_encrypted',
          ciphertext,
          group: toAddress,
          sender_identity: engine.identityKey,
          sender_signing_key: engine.signingKey,
        };
      } else {
        const inner = JSON.stringify({ from: currentStore.self, content: plainContent });
        const encrypted = requireEncrypted(
          await engine.encryptFor(toAddress, inner, fetchPrekeyBundle),
          `No usable prekey/session for ${toAddress}.`,
        );
        encryptedContent = {
          kind: 'encrypted',
          ciphertext: encrypted.ciphertext,
          ctype: encrypted.ctype,
          sender_identity: encrypted.sender_identity,
          sender_signing_key: engine.signingKey,
        };
      }
      const signature = engine.signCallData(`edit:${uuid}:${encryptedContent.ciphertext}`);
      activeConnection.publish(TOPIC_MSG_EDIT, JSON.stringify(
        buildWireEvent(currentStore.self, token(), { message_id: uuid, content: encryptedContent, signature }),
      ));
      engine.cacheInner(uuid, { from: currentStore.self, content: plainContent });
      const edited: ApiMessage = { ...message, content: { text: { text } }, isEdited: true };
      currentStore.putMessage(edited);
      deps.sendUpdate({ '@type': 'updateMessage', chatId: chat.id, id: message.id, isFull: true, message: edited });
      return undefined;
    },

    deleteMessages({ chat, messageIds }: { chat: ApiChat; messageIds: number[] }) {
      if (!connection()) return Promise.resolve(undefined);
      const currentStore = store();
      messageIds.forEach((id) => {
        const uuid = currentStore.getUuidForMessage(chat.id, id);
        if (!uuid) return;
        const signature = requireE2e(deps.getE2e()).signCallData(`delete:${uuid}`);
        connection()!.publish(TOPIC_MSG_DELETE, JSON.stringify(
          buildWireEvent(currentStore.self, token(), { message_id: uuid, signature }),
        ));
        deps.sync.markDeleted(uuid);
      });
      deps.sendUpdate({ '@type': 'deleteMessages', ids: messageIds, chatId: chat.id });
      return Promise.resolve(undefined);
    },

    sendReaction({ chat, messageId, reactions }: {
      chat: ApiChat; messageId: number; reactions?: { type: string; emoticon?: string }[];
    }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      if (!uuid || !connection()) return Promise.resolve(undefined);
      const emoji = reactions?.find((reaction) => reaction.type === 'emoji')?.emoticon || '';
      const signature = requireE2e(deps.getE2e()).signCallData(`react:${uuid}:${emoji}`);
      connection()!.publish(TOPIC_MSG_REACT, JSON.stringify(
        buildWireEvent(currentStore.self, token(), { message_id: uuid, emoji, signature }),
      ));
      const message = currentStore.getMessages(chat.id).find((candidate) => candidate.id === messageId);
      if (message) {
        let results = (message.reactions?.results || []).map((reaction) => {
          if (reaction.chosenOrder === undefined) return reaction;
          return { ...reaction, chosenOrder: undefined, count: reaction.count - 1 };
        }).filter((reaction) => reaction.count > 0);
        if (emoji) {
          const existing = results.find(
            (reaction) => reaction.reaction.type === 'emoji' && reaction.reaction.emoticon === emoji,
          );
          results = existing
            ? results.map((reaction) => (
              reaction === existing ? { ...reaction, count: reaction.count + 1, chosenOrder: 0 } : reaction
            ))
            : [...results, { count: 1, reaction: { type: 'emoji' as const, emoticon: emoji }, chosenOrder: 0 }];
        }
        const updated: ApiMessage = { ...message, reactions: { results } };
        currentStore.putMessage(updated);
        deps.sendUpdate({
          '@type': 'updateMessageReactions', chatId: chat.id, id: messageId, reactions: { results },
        });
      }
      return Promise.resolve(true);
    },

    pinMessage({ chat, messageId, isUnpin }: { chat: ApiChat; messageId: number; isUnpin: boolean }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      if (!uuid || !connection()) return Promise.resolve(undefined);
      const pin = !isUnpin;
      const signature = requireE2e(deps.getE2e()).signCallData(`pin:${uuid}:${pin}`);
      connection()!.publish(TOPIC_MSG_PIN, JSON.stringify(
        buildWireEvent(currentStore.self, token(), { message_id: uuid, pin, signature }),
      ));
      deps.sendUpdate({ '@type': 'updatePinnedIds', chatId: chat.id, isPinned: pin, messageIds: [messageId] });
      return Promise.resolve(undefined);
    },

    fetchPinnedMessages({ chat }: { chat: ApiChat }) {
      const messages = store().getMessages(chat.id).filter((message) => message.isPinned);
      return Promise.resolve({
        messages, users: deps.collectUsersFor(messages), chats: [chat], count: messages.length, topics: [],
      });
    },

    sendMessageAction({ peer, action }: { peer: { id: string }; action: { type: string } }) {
      if (action.type !== 'typing' || !connection()) return Promise.resolve(undefined);
      const currentStore = store();
      const toAddress = currentStore.getAddressForId(peer.id);
      if (!toAddress) return Promise.resolve(undefined);
      connection()!.publish(`msg.typing.${peer.id}`, JSON.stringify({ from: currentStore.self, to: toAddress }));
      return Promise.resolve(undefined);
    },

    async sendPollVote({ chat, messageId, options }: { chat: ApiChat; messageId: number; options: string[] }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!uuid || !toAddress) return undefined;
      const indices = options.map(Number).filter((value) => !Number.isNaN(value));
      deps.polls.applyVote(uuid, currentStore.self, indices);
      refreshPollMessage(uuid);
      await publishInner(toAddress, { kind: 'poll_vote', poll: uuid, options: indices });
      return true;
    },

    async closePoll({ chat, messageId }: { chat: ApiChat; messageId: number }) {
      const currentStore = store();
      const uuid = currentStore.getUuidForMessage(chat.id, messageId);
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!uuid || !toAddress) return undefined;
      deps.polls.close(uuid);
      refreshPollMessage(uuid);
      await publishInner(toAddress, { kind: 'poll_close', poll: uuid });
      return true;
    },

    setChatMessageAutoDeletePeriod({ chat, period }: { chat: ApiChat; period: number }) {
      const address = store().getAddressForId(chat.id);
      if (!address) return Promise.resolve(undefined);
      const ttl = deps.localState.loadPeerTtl();
      if (period > 0) ttl[address] = period;
      else delete ttl[address];
      deps.localState.savePeerTtl(ttl);
      return Promise.resolve(true);
    },

    markMessageListRead({ chat, maxId }: { chat: ApiChat; maxId?: number }) {
      const currentStore = store();
      currentStore.getMessages(chat.id).forEach((message) => {
        if (message.isOutgoing || (maxId && message.id > maxId)) return;
        const uuid = currentStore.getUuidForMessage(chat.id, message.id);
        if (!uuid || deps.sync.hasReportedRead(uuid)) return;
        deps.sync.markReportedRead(uuid);
        connection()!.publish(TOPIC_MSG_READ, JSON.stringify(
          buildWireEvent(currentStore.self, token(), { message_id: uuid }),
        ));
      });
      deps.sync.pushMentionState(chat.id);
      return Promise.resolve(undefined);
    },

    readAllMentions({ chat }: { chat: ApiChat }) {
      // Прочитанность у Parvane помессаджная: read по каждому упоминанию
      const currentStore = store();
      deps.sync.collectUnreadMentions(chat.id).forEach((id) => {
        const uuid = currentStore.getUuidForMessage(chat.id, id);
        if (!uuid || deps.sync.hasReportedRead(uuid)) return;
        deps.sync.markReportedRead(uuid);
        connection()!.publish(TOPIC_MSG_READ, JSON.stringify(
          buildWireEvent(currentStore.self, token(), { message_id: uuid }),
        ));
      });
      deps.sync.pushMentionState(chat.id);
      return Promise.resolve(true);
    },

    sendMessageLocal,
    sendMessage,

    async forwardMessages({ fromChat, toChat, messages }: {
      fromChat: ApiChat; toChat: ApiChat; messages: ApiMessage[];
    }) {
      const currentStore = store();
      const toAddress = currentStore.getAddressForId(toChat.id);
      if (!toAddress) return undefined;
      const fromAddress = currentStore.getAddressForId(fromChat.id) || '';
      for (const message of messages) {
        const wireContent = deps.media.messageToWireContent(message);
        if (!wireContent) continue;
        const originalSender = message.senderId ? currentStore.getAddressForId(message.senderId) : fromAddress;
        wireContent.forwarded_from = originalSender || fromAddress;
        wireContent.forwarded_name = originalSender
          ? currentStore.getDisplayName(originalSender)
          : currentStore.getDisplayName(fromAddress);
        const uuid = await publishInner(toAddress, wireContent);
        const id = currentStore.allocateMessageId(toChat.id, uuid);
        const localMessage: ApiMessage = {
          id,
          chatId: toChat.id,
          content: message.content,
          date: Math.floor(Date.now() / 1000),
          isForwardingAllowed: true,
          isOutgoing: true,
          senderId: deps.selfId(),
          forwardInfo: {
            date: message.date,
            isChannelPost: false,
            fromChatId: originalSender ? currentStore.getIdForAddress(originalSender) : undefined,
            hiddenUserName: wireContent.forwarded_name as string,
          },
        };
        currentStore.putMessage(localMessage);
        deps.sendUpdate({ '@type': 'newMessage', chatId: toChat.id, id, message: localMessage });
      }
      return true;
    },

    async parvaneSendLocation({ chat, lat, long }: { chat: ApiChat; lat: number; long: number }) {
      const currentStore = store();
      const toAddress = currentStore.getAddressForId(chat.id);
      if (!toAddress) return undefined;
      const uuid = await publishInner(toAddress, { kind: 'location', lat, long });
      const id = currentStore.allocateMessageId(chat.id, uuid);
      const message: ApiMessage = {
        id,
        chatId: chat.id,
        content: { location: { mediaType: 'geo', geo: { lat, long, accessHash: '0' } } },
        date: Math.floor(Date.now() / 1000),
        isOutgoing: true,
        senderId: deps.selfId(),
      };
      currentStore.putMessage(message);
      deps.sendUpdate({ '@type': 'newMessage', chatId: chat.id, id, message });
      return true;
    },
  };

  return {
    getSavedGifs: () => savedGifs,
    methods,
    rememberSavedGif,
    refreshPollMessage,
  };
}
