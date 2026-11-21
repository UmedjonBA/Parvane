import { memo } from '../../../../lib/teact/teact';

import useLang from '../../../../hooks/useLang';

import Modal from '../../../ui/Modal';

import styles from './Profile.module.scss';

type OwnProps = {
  isOpen: boolean;
  onClose: NoneToVoidFunction;
};

// Что входит в web-клиент и под какой лицензией (строка «Лицензии» в «О приложении», доски `RpProfileA`,
// `ZdProfileX`). Список — зависимости сборки (`package.json`) и шрифты макета; движок протокола — свой код Parvane
const LICENSES: { name: string; license: string }[] = [
  { name: 'Telegram Web A', license: 'GPL-3.0-or-later' },
  { name: '@cryptography/aes', license: 'GPL-3.0-or-later' },
  { name: '@noble/ciphers', license: 'MIT' },
  { name: 'async-mutex', license: 'MIT' },
  { name: 'colorjs.io', license: 'MIT' },
  { name: 'emoji-data-ios', license: 'MIT' },
  { name: 'fflate', license: 'MIT' },
  { name: 'idb-keyval', license: 'Apache-2.0' },
  { name: 'lovely-chart', license: 'MIT' },
  { name: 'lowlight', license: 'MIT' },
  { name: 'music-metadata', license: 'MIT' },
  { name: 'opus-recorder', license: 'MIT' },
  { name: 'qr-code-styling', license: 'MIT' },
  { name: 'temml', license: 'MIT' },
  { name: 'IBM Plex Sans', license: 'OFL-1.1' },
  { name: 'JetBrains Mono', license: 'OFL-1.1' },
];

const LicensesDialog = ({ isOpen, onClose }: OwnProps) => {
  const lang = useLang();

  return (
    <Modal isOpen={isOpen} title={lang('ParvaneAboutLicenses')} hasCloseButton onClose={onClose}>
      <div className={styles.fieldHint}>{lang('ParvaneAboutLicensesHint')}</div>
      <div className={styles.dialogGroup} data-licenses>
        {LICENSES.map(({ name, license }) => (
          <div key={name} className={styles.setRow}>
            <span className={styles.setTitle}>{name}</span>
            <span className={styles.setValue}>{license}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
};

export default memo(LicensesDialog);
