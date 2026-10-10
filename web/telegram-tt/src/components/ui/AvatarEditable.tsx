import type { ChangeEvent } from 'react';
import type { FC } from '../../lib/teact/teact';
import {
  memo, useCallback, useEffect, useState,
} from '../../lib/teact/teact';

import buildClassName from '../../util/buildClassName';

import useLang from '../../hooks/useLang';
import useUniqueId from '../../hooks/useUniqueId';

import Icon from '../common/icons/Icon';
import CropModal from './CropModal';

import './AvatarEditable.scss';

interface OwnProps {
  title?: string;
  disabled?: boolean;
  isForForum?: boolean;
  currentAvatarBlobUrl?: string;
  // Parvane: подпись-кнопка под кругом — без неё не видно, что круг нажимается
  actionLabel?: string;
  onChange: (file: File) => void;
}

const AvatarEditable: FC<OwnProps> = ({
  title,
  disabled,
  isForForum,
  currentAvatarBlobUrl,
  actionLabel,
  onChange,
}) => {
  const inputId = useUniqueId();
  const [selectedFile, setSelectedFile] = useState<File | undefined>();
  const [croppedBlobUrl, setCroppedBlobUrl] = useState<string | undefined>(currentAvatarBlobUrl);

  const lang = useLang();

  useEffect(() => {
    setCroppedBlobUrl(currentAvatarBlobUrl);
  }, [currentAvatarBlobUrl]);

  function handleSelectFile(event: ChangeEvent<HTMLInputElement>) {
    const target = event.target;

    if (!target?.files?.[0]) {
      return;
    }

    setSelectedFile(target.files[0]);
    target.value = '';
  }

  const handleAvatarCrop = useCallback((croppedImg: File) => {
    setSelectedFile(undefined);
    onChange(croppedImg);

    if (croppedBlobUrl && croppedBlobUrl !== currentAvatarBlobUrl) {
      URL.revokeObjectURL(croppedBlobUrl);
    }
    setCroppedBlobUrl(URL.createObjectURL(croppedImg));
  }, [croppedBlobUrl, currentAvatarBlobUrl, onChange]);

  const handleModalClose = useCallback(() => {
    setSelectedFile(undefined);
  }, []);

  const labelClassName = buildClassName(
    croppedBlobUrl && 'filled',
    disabled && 'disabled',
    isForForum && 'rounded-square',
  );

  return (
    <div className="AvatarEditable">
      <label
        className={labelClassName}
        role="button"
        tabIndex={0}
        title={title || lang('ChangeYourProfilePicture')}
      >
        <input
          id={inputId}
          type="file"
          onChange={handleSelectFile}
          accept="image/png, image/jpeg"
        />
        <Icon name="camera-add" />
        {croppedBlobUrl && <img src={croppedBlobUrl} draggable={false} alt="" />}
      </label>
      {actionLabel && !disabled && (
        <label className="action" htmlFor={inputId} role="button" tabIndex={0}>
          <Icon name="camera-add" />
          {actionLabel}
        </label>
      )}
      <CropModal file={selectedFile} onClose={handleModalClose} onChange={handleAvatarCrop} />
    </div>
  );
};

export default memo(AvatarEditable);
