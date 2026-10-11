import {
  memo, useEffect, useMemo, useRef, useState,
} from '../../../lib/teact/teact';

import type { CloudNode } from './cloudModel';

import buildClassName from '../../../util/buildClassName';
import { canMoveInto, childrenOf, pathOf, sortNodes, validateName } from './cloudModel';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import InputText from '../../ui/InputText';
import Modal from '../../ui/Modal';

import styles from './Cloud.module.scss';

type NameProps = {
  isOpen: boolean;
  title: string;
  label: string;
  confirmLabel: string;
  initialName?: string;
  onSubmit: (name: string) => void;
  onClose: NoneToVoidFunction;
};

const NAME_SORT = { key: 'name', isDescending: false } as const;

// Название новой папки либо новое имя файла/папки: проверка — как в движке
const CloudNameDialogBase = ({
  isOpen, title, label, confirmLabel, initialName, onSubmit, onClose,
}: NameProps) => {
  const lang = useLang();
  const [name, setName] = useState('');
  const [hasTried, setHasTried] = useState(false);
  const inputRef = useRef<HTMLInputElement>();

  useEffect(() => {
    if (!isOpen) return;
    setName(initialName || '');
    setHasTried(false);
  }, [isOpen, initialName]);

  const problem = validateName(name.trim());
  const errorText = !hasTried || !problem ? undefined
    : problem === 'empty' ? lang('ParvaneCloudErrorNameEmpty')
      : problem === 'too-long' ? lang('ParvaneCloudErrorNameLong') : lang('ParvaneCloudErrorNameChars');

  const handleChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  });

  const handleSubmit = useLastCallback((e?: React.FormEvent) => {
    e?.preventDefault();
    // Значение берём из самого поля: набранное сразу после открытия могло не успеть попасть в состояние
    const value = (inputRef.current?.value ?? name).trim();
    setName(value);
    setHasTried(true);
    if (validateName(value)) return;
    onSubmit(value);
  });

  return (
    <Modal isOpen={isOpen} title={title} className={styles.dialog} onClose={onClose} onEnter={handleSubmit}>
      <form className={styles.dialogForm} onSubmit={handleSubmit}>
        <InputText
          ref={inputRef}
          id="parvane-cloud-name"
          label={label}
          value={name}
          error={errorText}
          onChange={handleChange}
        />
        <div className="dialog-buttons">
          <Button className="confirm-dialog-button" isText onClick={handleSubmit}>{confirmLabel}</Button>
          <Button className="confirm-dialog-button" isText onClick={onClose}>{lang('ParvaneCloudCancel')}</Button>
        </div>
      </form>
    </Modal>
  );
};

type MoveProps = {
  isOpen: boolean;
  rootName: string;
  nodes: CloudNode[];
  movedIds: string[];
  startFolder?: string;
  confirmLabel?: string;
  title?: string;
  onSubmit: (target?: string) => void;
  onClose: NoneToVoidFunction;
};

// Выбор папки назначения: проход по дереву, папка не может попасть в себя и во вложенную
const CloudFolderDialogBase = ({
  isOpen, rootName, nodes, movedIds, startFolder, confirmLabel, title, onSubmit, onClose,
}: MoveProps) => {
  const lang = useLang();
  const [folder, setFolder] = useState<string>();

  useEffect(() => {
    if (isOpen) setFolder(startFolder);
  }, [isOpen, startFolder]);

  const path = useMemo(() => pathOf(nodes, folder), [nodes, folder]);
  const folders = useMemo(() => (
    sortNodes(childrenOf(nodes, folder).filter((n) => n.kind === 'folder'), NAME_SORT)
  ), [nodes, folder]);
  const isAllowed = canMoveInto(nodes, movedIds, folder);

  const handleSubmit = useLastCallback(() => {
    if (isAllowed) onSubmit(folder);
  });

  return (
    <Modal
      isOpen={isOpen}
      title={title || lang('ParvaneCloudMoveTitle')}
      className={styles.dialog}
      onClose={onClose}
    >
      <div className={styles.dialogPath}>
        <button type="button" className={styles.pathLink} onClick={() => setFolder(undefined)}>{rootName}</button>
        {path.map((n) => (
          <span key={n.id} className={styles.pathStep}>
            <Icon name="next" className={styles.pathArrow} />
            <button type="button" className={styles.pathLink} onClick={() => setFolder(n.id)}>{n.name}</button>
          </span>
        ))}
      </div>
      <div className={buildClassName(styles.dialogList, 'custom-scroll')} role="list">
        {folders.map((n) => (
          <button
            key={n.id}
            type="button"
            role="listitem"
            className={styles.dialogFolder}
            disabled={movedIds.includes(n.id)}
            onClick={() => setFolder(n.id)}
          >
            <Icon name="folder" />
            <span className={styles.dialogFolderName} dir="auto">{n.name}</span>
          </button>
        ))}
        {!folders.length && <div className={styles.dialogEmpty}>{lang('ParvaneCloudEmptyFolder')}</div>}
      </div>
      <div className="dialog-buttons">
        <Button className="confirm-dialog-button" isText disabled={!isAllowed} onClick={handleSubmit}>
          {confirmLabel || lang('ParvaneCloudMoveHere')}
        </Button>
        <Button className="confirm-dialog-button" isText onClick={onClose}>{lang('ParvaneCloudCancel')}</Button>
      </div>
    </Modal>
  );
};

export const CloudNameDialog = memo(CloudNameDialogBase);
export const CloudFolderDialog = memo(CloudFolderDialogBase);
