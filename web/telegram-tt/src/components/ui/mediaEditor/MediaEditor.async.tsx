import { Bundles } from '../../../util/moduleLoader';

import useModuleLoader from '../../../hooks/useModuleLoader';

// Свойства — как у `MediaEditor` (тип там не экспортируется, а сам модуль здесь импортировать нельзя:
// он уехал бы в кусок окна вложений)
type OwnProps = {
  isOpen: boolean;
  imageUrl?: string;
  mimeType?: string;
  filename?: string;
  onClose: VoidFunction;
  onSave: (file: File) => void;
};

const MediaEditorAsync = (props: OwnProps) => {
  const { isOpen } = props;
  const MediaEditor = useModuleLoader(Bundles.MediaEditor, 'MediaEditor', !isOpen);

  return MediaEditor ? <MediaEditor {...props} /> : undefined;
};

export default MediaEditorAsync;
