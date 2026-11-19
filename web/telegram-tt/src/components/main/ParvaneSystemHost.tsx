import { memo, useEffect, useState } from '../../lib/teact/teact';
import { getActions } from '../../global';

import type { SharedPayload } from '../../util/shareTarget';
import { LeftColumnContent } from '../../types';

import { consumeLaunchRequest, getLaunchRequest } from '../../util/parvaneSection';
import { takeSharedPayload } from '../../util/sharedInbox';

import useDerivedState from '../../hooks/useDerivedState';
import useLastCallback from '../../hooks/useLastCallback';

import ShareSheet from '../parvane/share/ShareSheet';

// Parvane (spec 041 F2): то, что приходит от системы и ждёт вошедшего приложения, — ярлык «Новое сообщение»
// и экран «Поделиться в Parvane» (адрес запуска `?open=compose | share`, `util/parvaneSection.ts`)
const ParvaneSystemHost = () => {
  const { openLeftColumnContent } = getActions();
  const [shared, setShared] = useState<SharedPayload | undefined>();
  const request = useDerivedState(getLaunchRequest);

  useEffect(() => {
    if (!request) return;
    consumeLaunchRequest();
    if (request === 'compose') {
      openLeftColumnContent({ contentKey: LeftColumnContent.Contacts });
      return;
    }
    void takeSharedPayload().then(setShared);
  }, [request, openLeftColumnContent]);

  const handleClose = useLastCallback(() => setShared(undefined));

  return <ShareSheet shared={shared} onClose={handleClose} />;
};

export default memo(ParvaneSystemHost);
