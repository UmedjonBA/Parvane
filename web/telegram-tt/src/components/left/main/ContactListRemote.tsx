import { memo, useState } from '../../../lib/teact/teact';
import { getActions } from '../../../global';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import kit from '../../parvane/notes/PvKit.module.scss';
import styles from './ContactList.module.scss';

// «С другого сервера» внизу «Нового сообщения» (доска `ZpChat2`): чат по полному нику `@ник@сервер`
const ContactListRemote = () => {
  const { openChatByUsername } = getActions();
  const lang = useLang();
  const [nick, setNick] = useState('');

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setNick(e.currentTarget.value);
  });

  const handleSubmit = useLastCallback((e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const username = nick.trim().replace(/^@/, '');
    if (!username) return;
    openChatByUsername({ username });
  });

  return (
    <form className={styles.remote} onSubmit={handleSubmit} data-contacts-remote>
      <div className={styles.caption}>{lang('ParvaneContactsRemote')}</div>
      <label className={styles.field}>
        <span className={styles.fieldLabel}>{lang('ParvaneContactsRemoteLabel')}</span>
        <input
          className={kit.input}
          value={nick}
          placeholder={lang('ParvaneContactsRemotePlaceholder')}
          autoComplete="off"
          spellCheck={false}
          onChange={handleChange}
        />
      </label>
      <p className={styles.hint}>{lang('ParvaneContactsRemoteHint')}</p>
    </form>
  );
};

export default memo(ContactListRemote);
