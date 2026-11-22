import type { ChangeEvent } from 'react';
import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { TabState } from '../../../global/types';
import type { RegularLangKey } from '../../../types/language';

import { getUserFullName, isChatGroup } from '../../../global/helpers';
import { selectChat, selectChatMessage, selectUser } from '../../../global/selectors';
import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import PvSheet from '../../parvane/notes/PvSheet';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './ReportModal.module.scss';

const MAX_DESCRIPTION = 1024;
const QUOTE_MAX = 60;
const SUBMIT_MARK = ':send';
const TARGET_KEYS: Record<string, RegularLangKey> = {
  admins: 'ParvaneReportTargetAdmins',
  server: 'ParvaneReportTargetServer',
};

export type OwnProps = {
  modal: TabState['reportModal'];
};

type StateProps = {
  authorName?: string;
  messageText?: string;
  // Автор сообщения группы, чьи сообщения можно скрыть у себя (не сам пользователь)
  hideableAuthorId?: string;
};

// Parvane (spec 041, доска `XdChat`; REPORT-2): жалоба одной формой — причина чипами, комментарий, кому уходит.
// Причины и адресатов отдаёт провайдер (их выбирает движок), окно только показывает и отправляет
const ReportModal = ({
  modal, authorName, messageText, hideableAuthorId,
}: OwnProps & StateProps) => {
  const { reportMessages, closeReportModal, parvaneSetMemberHidden } = getActions();
  const lang = useLang();

  const section = modal?.sections[0];
  const options = section?.type === 'options' ? section.options : undefined;
  const targets = section?.type === 'options' ? section.targets || [] : [];

  const [reason, setReason] = useState<string | undefined>();
  const [target, setTarget] = useState<string | undefined>();
  const [text, setText] = useState('');
  // «Скрыть у меня сообщения этого участника» — включено по умолчанию, как на доске `XdChat`
  const [shouldHideAuthor, setShouldHideAuthor] = useState(true);

  // Начальные значения формы — до первого кадра (правило экрана spec 041)
  useLayoutEffect(() => {
    const isOptions = section?.type === 'options';
    setReason(isOptions ? section.options[0]?.option : undefined);
    setTarget(isOptions ? section.targets?.[0] : undefined);
    setText('');
    setShouldHideAuthor(true);
  }, [section]);

  const handleTextChange = useLastCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
  });

  const handleClose = useLastCallback(() => {
    closeReportModal();
  });

  const handleHideChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setShouldHideAuthor(e.target.checked);
  });

  const handleSend = useLastCallback(() => {
    if (!modal?.chatId || !reason || !target) return;
    if (hideableAuthorId && shouldHideAuthor) {
      parvaneSetMemberHidden({ chatId: modal.chatId, userId: hideableAuthorId, isHidden: true });
    }
    reportMessages({
      chatId: modal.chatId,
      messageIds: modal.messageIds,
      option: `${reason}${SUBMIT_MARK}`,
      description: text.trim(),
      target,
    });
    closeReportModal();
  });

  const hasMessage = Boolean(modal?.messageIds.length);
  const quote = messageText && messageText.length > QUOTE_MAX ? `${messageText.slice(0, QUOTE_MAX)}…` : messageText;

  return (
    <PvSheet
      isOpen={Boolean(modal)}
      title={lang(hasMessage ? 'ParvaneReportMessageTitle' : 'ParvaneReportChatTitle')}
      className={styles.root}
      onClose={handleClose}
    >
      {hasMessage && (authorName || quote) && (
        <div className={buildClassName(kit.small, kit.muted, styles.subject)} dir="auto" data-report-subject>
          {[authorName, quote && lang('PvQuoted', { text: quote })].filter(Boolean).join(' · ')}
        </div>
      )}
      <div className={kit.caps}>{lang('ParvaneReportReasonLabel')}</div>
      <div className={kit.chips} role="radiogroup" aria-label={lang('ParvaneReportReasonLabel')}>
        {options?.map((option) => (
          <button
            key={option.option}
            type="button"
            role="radio"
            aria-checked={option.option === reason}
            className={buildClassName(kit.chip, option.option === reason && kit.chipOn)}
            data-report-reason={option.option}
            onClick={() => setReason(option.option)}
          >
            {translateParvane(lang, option.text)}
          </button>
        ))}
      </div>
      <label className={styles.field}>
        <span className={buildClassName(kit.small, kit.muted)}>{lang('ParvaneReportCommentLabel')}</span>
        <textarea
          className={buildClassName(kit.textarea, styles.comment)}
          placeholder={lang('ParvaneReportCommentHint')}
          value={text}
          maxLength={MAX_DESCRIPTION}
          data-report-comment
          onChange={handleTextChange}
        />
      </label>
      {targets.length > 0 && (
        <>
          <div className={kit.caps}>{lang('ParvaneReportTargetLabel')}</div>
          <div className={buildClassName(kit.seg, styles.targets)} role="radiogroup">
            {targets.map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={item === target}
                className={buildClassName(kit.segItem, styles.target, item === target && kit.segItemOn)}
                data-report-target={item}
                onClick={() => setTarget(item)}
              >
                {TARGET_KEYS[item] ? lang(TARGET_KEYS[item]) : item}
              </button>
            ))}
          </div>
        </>
      )}
      <div className={buildClassName(kit.small, kit.muted, styles.note)} data-report-note>
        {lang(!target
          ? 'ParvaneReportNowhere'
          : target === 'admins' ? 'ParvaneReportNoteAdmins' : 'ParvaneReportNoteServer')}
      </div>
      <div className={buildClassName(kit.sheetButtons, styles.buttons)}>
        {hideableAuthorId && (
          <label className={buildClassName(kit.small, styles.hideAuthor)}>
            <input
              type="checkbox"
              className={styles.hideAuthorCheck}
              checked={shouldHideAuthor}
              data-report-hide-author
              onChange={handleHideChange}
            />
            {lang('ParvaneReportHideAuthor')}
          </label>
        )}
        <button type="button" className={kit.btn} onClick={handleClose}>{lang('Cancel')}</button>
        <button
          type="button"
          className={buildClassName(kit.btn, kit.btnAcc)}
          disabled={!reason || !target}
          data-report-send
          onClick={handleSend}
        >
          {lang('ParvaneReportSend')}
        </button>
      </div>
    </PvSheet>
  );
};

export default memo(withGlobal<OwnProps>((global, { modal }): Complete<StateProps> => {
  const messageId = modal?.messageIds[0];
  const message = modal?.chatId && messageId ? selectChatMessage(global, modal.chatId, messageId) : undefined;
  const author = message?.senderId ? selectUser(global, message.senderId) : undefined;
  const chat = modal?.chatId ? selectChat(global, modal.chatId) : undefined;
  const isOthersGroupMessage = Boolean(chat && isChatGroup(chat) && author && author.id !== global.currentUserId);
  return {
    authorName: author ? getUserFullName(author) : undefined,
    messageText: message?.content.text?.text,
    hideableAuthorId: isOthersGroupMessage ? author!.id : undefined,
  };
})(ReportModal));

// Причины провайдер отдаёт ключами строк (`Parvane…`) — переводит окно
function translateParvane(lang: ReturnType<typeof useLang>, text: string) {
  return text.startsWith('Parvane') ? lang(text as RegularLangKey) : text;
}
