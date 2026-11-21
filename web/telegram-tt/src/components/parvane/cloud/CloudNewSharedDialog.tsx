import {
  memo, useLayoutEffect, useRef, useState,
} from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import type { CloudResult } from '../../../api/parvane/cloudDrive';
import type { ApiChatMember } from '../../../api/types';

import { getUserFullName } from '../../../global/helpers/users';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { addressOfNick, validateName } from './cloudModel';
import { getPeerHandle, getPeerName } from './cloudPeople';
import { getCloudData, showCloudNotice } from './cloudStore';

import useFlag from '../../../hooks/useFlag';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import RecipientPicker from '../../common/RecipientPicker';
import PvSheet from '../notes/PvSheet';

import kit from '../notes/PvKit.module.scss';
import styles from './CloudSheets.module.scss';

type OwnProps = {
  isOpen: boolean;
  // Телефон (доска `ZpFilesX`): экран целиком, «✕» слева и «Создать» в шапке
  isNarrow?: boolean;
  onCreated: (container: string) => void;
  onClose: NoneToVoidFunction;
};

type ShareRole = 'editor' | 'reader';
// Кого позвать: id чата с человеком (как у выбора из контактов); имя и ник — для строки
type Invitee = { chatId: string; name: string; handle?: string; role: ShareRole };
type Picker = 'contacts' | 'group';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;
const USER_CHAT_TYPES = ['users'] as const;
const GROUP_CHAT_TYPES = ['groups', 'chats'] as const;
const SHARE_ROLES: ShareRole[] = ['editor', 'reader'];
const AVATAR_TONES = ['orange', 'purple', 'red', 'aqua', 'green'];

function initialOf(name: string) {
  return (Array.from(name)[0] || '').toUpperCase();
}

function inviteeOfUser(userId: string): Invitee | undefined {
  const user = getGlobal().users.byId[userId];
  if (!user || user.isSelf) return undefined;
  const nick = user.usernames?.[0]?.username;
  return {
    chatId: userId,
    name: getUserFullName(user) || nick || userId,
    handle: nick ? `@${nick}` : undefined,
    role: 'reader',
  };
}

// «Новая общая папка» одним экраном (доска `ZpFilesX`): название, участники с ролью-чипом (ник, «Из контактов»,
// «Позвать всех из чата…»); «Создать» создаёт папку и рассылает приглашения, затем открывает её доступ
const CloudNewSharedDialog = ({
  isOpen, isNarrow, onCreated, onClose,
}: OwnProps) => {
  const lang = useLang();
  const [name, setName] = useState('');
  const [hasTried, setHasTried] = useState(false);
  const [invitees, setInvitees] = useState<Invitee[]>([]);
  const [picker, setPicker] = useState<Picker>();
  const [nickError, setNickError] = useState<string>();
  const [isBusy, markBusy, unmarkBusy] = useFlag();
  const nameRef = useRef<HTMLInputElement>();
  const nickRef = useRef<HTMLInputElement>();

  // Экран готовится к вводу в кадре появления
  useLayoutEffect(() => {
    if (!isOpen) return;
    setName('');
    setHasTried(false);
    setInvitees([]);
    setPicker(undefined);
    setNickError(undefined);
    if (nickRef.current) nickRef.current.value = '';
  }, [isOpen]);

  const addInvitees = (list: Invitee[]) => {
    setInvitees((current) => [...current, ...list.filter((i) => !current.some((c) => c.chatId === i.chatId))]);
  };

  const handleNameChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  });

  const handleNick = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const text = nickRef.current?.value || '';
    if (!text.trim()) {
      setPicker('contacts');
      return;
    }
    const selfDomain = getCloudData()?.containers.find((c) => c.kind === 'root')?.owner.split('@')[1];
    const user = addressOfNick(text, selfDomain);
    if (!user) {
      setNickError(lang('ParvaneCloudNickInvalid'));
      return;
    }
    markBusy();
    const chatId = await callParvane('parvaneResolveExactAddress', { address: user })
      .catch(() => undefined) as string | undefined;
    unmarkBusy();
    if (!chatId) {
      setNickError(lang('ParvaneCloudNickNotFound'));
      return;
    }
    addInvitees([{
      chatId, name: getPeerName(user), handle: getPeerHandle(user), role: 'reader',
    }]);
    if (nickRef.current) nickRef.current.value = '';
    setNickError(undefined);
  });

  const handleNickInput = useLastCallback(() => setNickError(undefined));

  const handlePick = useLastCallback(async (chatId: string) => {
    const kind = picker;
    setPicker(undefined);
    if (kind === 'contacts') {
      const one = inviteeOfUser(chatId);
      if (one) addInvitees([one]);
      return;
    }
    // «Позвать всех из чата…»: участники группы (кроме себя) — читателями
    const chat = getGlobal().chats.byId[chatId];
    if (!chat) return;
    const result = await callApi('fetchMembers', { chat }).catch(() => undefined) as
      { members?: ApiChatMember[] } | undefined;
    addInvitees((result?.members || []).map((m) => inviteeOfUser(m.userId))
      .filter((i): i is Invitee => Boolean(i)));
  });

  const handleRole = useLastCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const { chatId } = e.currentTarget.dataset;
    const value = e.currentTarget.value;
    setInvitees((current) => (value === 'remove' ? current.filter((i) => i.chatId !== chatId)
      : current.map((i) => (i.chatId === chatId ? { ...i, role: value as ShareRole } : i))));
  });

  const handleCreate = useLastCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    const value = (nameRef.current?.value ?? name).trim();
    setName(value);
    setHasTried(true);
    if (validateName(value) || isBusy) return;
    markBusy();
    try {
      const result = await callParvane('parvaneCloudCreateShared', { name: value }).catch(() => undefined) as
        CloudResult<{ container: string }> | undefined;
      if (!result?.ok) {
        showCloudNotice(result?.error || 'rejected');
        return;
      }
      for (const invitee of invitees) {
        const role = lang(invitee.role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader');
        const shared = await callParvane('parvaneCloudShare', {
          container: result.container,
          chatId: invitee.chatId,
          role: invitee.role,
          inviteText: lang('ParvaneCloudInviteText', { name: value, role: role.toLocaleLowerCase() }),
        }).catch(() => undefined) as CloudResult | undefined;
        if (!shared?.ok) showCloudNotice(shared?.error || 'rejected');
      }
      onCreated(result.container);
    } finally {
      unmarkBusy();
    }
  });

  const problem = hasTried ? validateName(name.trim()) : undefined;
  const nameError = !problem ? undefined
    : problem === 'empty' ? lang('ParvaneCloudErrorNameEmpty')
      : problem === 'too-long' ? lang('ParvaneCloudErrorNameLong') : lang('ParvaneCloudErrorNameChars');

  const createButton = (
    <button
      type="button"
      className={buildClassName(kit.btn, kit.btnAcc)}
      disabled={isBusy}
      data-new-shared-create
      onClick={handleCreate}
    >
      {lang('ParvaneCloudCreate')}
    </button>
  );

  return (
    <>
      <PvSheet
        isOpen={isOpen && !picker}
        title={lang('ParvaneCloudNewShared')}
        className={buildClassName(styles.narrow, styles.full)}
        startClose={isNarrow ? 'cancel' : undefined}
        headAfter={isNarrow ? createButton : undefined}
        onClose={onClose}
      >
        <form className={styles.form} onSubmit={handleCreate} data-new-shared>
          <label className={styles.field}>
            {lang('ParvaneCloudNameLabel')}
            <input
              ref={nameRef}
              id="parvane-cloud-shared-name"
              className={kit.input}
              value={name}
              aria-label={lang('ParvaneCloudNameLabel')}
              aria-invalid={Boolean(nameError)}
              autoComplete="off"
              onChange={handleNameChange}
            />
          </label>
          {nameError && <div className={kit.fieldError} role="alert">{nameError}</div>}
        </form>
        <h3 className={styles.caption}>{lang('ParvaneCloudMembersCaption')}</h3>
        <form className={styles.shareNick} onSubmit={handleNick} data-new-shared-nick>
          <span className={styles.shareNickRow}>
            <input
              ref={nickRef}
              className={buildClassName(kit.input, styles.shareNickInput)}
              placeholder="@nick"
              aria-label={lang('ParvaneCloudNickLabel')}
              aria-invalid={Boolean(nickError)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="send"
              onInput={handleNickInput}
            />
            <button type="submit" className={kit.btn} disabled={isBusy}>{lang('ParvaneCloudNickAdd')}</button>
          </span>
          {nickError && <div className={kit.fieldError} role="alert">{nickError}</div>}
        </form>
        {invitees.length > 0 && (
          <div className={styles.members} role="list">
            {invitees.map((invitee, index) => (
              <div
                key={invitee.chatId}
                className={styles.member}
                role="listitem"
                data-new-invitee={invitee.chatId}
                data-role={invitee.role}
              >
                <span className={styles.avatar} style={`--c: var(--pv-${AVATAR_TONES[index % AVATAR_TONES.length]})`}>
                  {initialOf(invitee.name)}
                </span>
                <span className={styles.memberText}>
                  <span className={styles.memberName} dir="auto">{invitee.name}</span>
                  {invitee.handle && <span className={styles.memberSub} dir="ltr">{invitee.handle}</span>}
                </span>
                <select
                  className={buildClassName(styles.role, styles.roleChip)}
                  value={invitee.role}
                  aria-label={lang('ParvaneCloudRoleChange', { name: invitee.name })}
                  data-chat-id={invitee.chatId}
                  onChange={handleRole}
                >
                  {SHARE_ROLES.map((role) => (
                    <option key={role} value={role} selected={role === invitee.role}>
                      {lang(role === 'editor' ? 'ParvaneCloudRoleEditor' : 'ParvaneCloudRoleReader')}
                    </option>
                  ))}
                  <option value="remove">{lang('ParvaneCloudRemoveMember')}</option>
                </select>
              </div>
            ))}
          </div>
        )}
        <div className={styles.linkPairStart}>
          <button type="button" className={kit.btn} data-new-shared-contacts onClick={() => setPicker('contacts')}>
            {lang('ParvaneCloudFromContacts')}
          </button>
          <button type="button" className={kit.btn} data-new-shared-group onClick={() => setPicker('group')}>
            {lang('ParvaneCloudInviteChat')}
          </button>
        </div>
        <div className={styles.note}>{lang('ParvaneCloudNewSharedNote')}</div>
        {!isNarrow && (
          <div className={styles.buttons}>
            <button type="button" className={kit.btn} onClick={onClose}>{lang('Cancel')}</button>
            {createButton}
          </div>
        )}
      </PvSheet>
      <RecipientPicker
        isOpen={isOpen && Boolean(picker)}
        title={lang(picker === 'group' ? 'ParvaneCloudInviteChat' : 'ParvaneCloudShareAdd')}
        searchPlaceholder={lang('Search')}
        filter={picker === 'group' ? GROUP_CHAT_TYPES : USER_CHAT_TYPES}
        onSelectRecipient={handlePick}
        onClose={() => setPicker(undefined)}
      />
    </>
  );
};

export default memo(CloudNewSharedDialog);
