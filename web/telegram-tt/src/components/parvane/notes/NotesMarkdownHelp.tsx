import { memo } from '../../../lib/teact/teact';

import type { RegularLangKey } from '../../../types/language';

import buildClassName from '../../../util/buildClassName';

import useLang from '../../../hooks/useLang';

import styles from './NotesHelp.module.scss';
import kit from './PvKit.module.scss';

type OwnProps = {
  // Экран модуля на компьютере (шапка с названием); без него — содержимое шторки редактора
  isScreen?: boolean;
};

// Строка шпаргалки: что пишете (разметка, ключ строки) → что это даёт (ключ строки)
type HelpRow = { sample: RegularLangKey; meaning: RegularLangKey };

const TEXT_ROWS: HelpRow[] = [
  { sample: 'KnowledgeMdHelpHeadingSample', meaning: 'KnowledgeMdHelpHeading' },
  { sample: 'KnowledgeMdHelpBoldSample', meaning: 'KnowledgeMdHelpBold' },
  { sample: 'KnowledgeMdHelpListSample', meaning: 'KnowledgeMdHelpList' },
  { sample: 'KnowledgeMdHelpTaskSample', meaning: 'KnowledgeMdHelpTask' },
  { sample: 'KnowledgeMdHelpQuoteSample', meaning: 'KnowledgeMdHelpQuote' },
  { sample: 'KnowledgeMdHelpCodeSample', meaning: 'KnowledgeMdHelpCode' },
];
const LINK_ROWS: HelpRow[] = [
  { sample: 'KnowledgeMdHelpNoteSample', meaning: 'KnowledgeMdHelpNote' },
  { sample: 'KnowledgeMdHelpTagSample', meaning: 'KnowledgeMdHelpTag' },
  { sample: 'KnowledgeMdHelpEmbedSample', meaning: 'KnowledgeMdHelpEmbed' },
  { sample: 'KnowledgeMdHelpWebSample', meaning: 'KnowledgeMdHelpWeb' },
];
const KEY_ROWS: { meaning: RegularLangKey; keys: string[] }[] = [
  { meaning: 'KnowledgeMdHelpKeyMode', keys: ['Ctrl+E'] },
  { meaning: 'KnowledgeMdHelpKeyBold', keys: ['Ctrl+B', 'Ctrl+I'] },
];

// Справка по разметке заметок (доска `ZdNotesX`): «пишете слева — в просмотре видите справа» — текст, связи и
// вложения, клавиши. Только показ: разбор Markdown — общий (MD-1), здесь его не меняют
const NotesMarkdownHelp = ({ isScreen }: OwnProps) => {
  const lang = useLang();

  function renderRows(rows: HelpRow[]) {
    return (
      <div className={kit.card}>
        {rows.map((row) => (
          <div key={row.sample} className={styles.row} data-md-help-row>
            <code className={styles.sample}>{lang(row.sample)}</code>
            <span className={styles.meaning}>{lang(row.meaning)}</span>
          </div>
        ))}
      </div>
    );
  }

  return (
    <section
      className={buildClassName(styles.root, isScreen && styles.screen, isScreen && 'custom-scroll')}
      data-notes-md-help
    >
      {isScreen && (
        <header className={styles.head}>
          <h1 className={styles.title}>{lang('KnowledgeMdHelp')}</h1>
          <span className={styles.subtitle}>{lang('KnowledgeMdHelpSubtitle')}</span>
        </header>
      )}
      <div className={styles.columns}>
        <div className={styles.column}>
          <h2 className={styles.cap}>{lang('KnowledgeMdHelpText')}</h2>
          {renderRows(TEXT_ROWS)}
        </div>
        <div className={styles.column}>
          <h2 className={styles.cap}>{lang('KnowledgeMdHelpLinks')}</h2>
          {renderRows(LINK_ROWS)}
          <h2 className={styles.cap}>{lang('KnowledgeMdHelpKeys')}</h2>
          <div className={kit.card}>
            {KEY_ROWS.map((row) => (
              <div key={row.meaning} className={styles.row} data-md-help-key>
                <span className={styles.keyMeaning}>{lang(row.meaning)}</span>
                <span className={styles.keys}>
                  {row.keys.map((key) => <kbd key={key} className={styles.kbd}>{key}</kbd>)}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};

export default memo(NotesMarkdownHelp);
