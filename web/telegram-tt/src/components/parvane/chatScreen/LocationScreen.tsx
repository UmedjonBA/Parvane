import { memo, useLayoutEffect, useState } from '../../../lib/teact/teact';
import { getGlobal } from '../../../global';

import { buildStaticMapHash } from '../../../global/helpers';
import buildClassName from '../../../util/buildClassName';
import { callApi } from '../../../api/gramjs';
import { parseCoordinates } from './locationInput';

import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import useMedia from '../../../hooks/useMedia';

import PvSegment from '../notes/PvSegment';
import ChatScreen from './ChatScreen';

import kit from '../notes/PvKit.module.scss';
import screen from './ChatScreen.module.scss';
import styles from './LocationScreen.module.scss';

type OwnProps = {
  isOpen: boolean;
  chatId: string;
  onClose: NoneToVoidFunction;
};

type Period = '900' | '3600' | '28800';
type Position = { lat: number; long: number; accuracy?: number; heading?: number };

const PERIODS: Period[] = ['900', '3600', '28800'];
const PERIOD_KEYS = {
  900: 'LocationPeriod15Min',
  3600: 'LocationPeriod1Hour',
  28800: 'LocationPeriod8Hours',
} as const;
const START_KEYS = {
  900: 'LocationStart15Min',
  3600: 'LocationStart1Hour',
  28800: 'LocationStart8Hours',
} as const;
const MAP_WIDTH = 480;
const MAP_HEIGHT = 300;
const MAP_ZOOM = 15;
const MAP_SCALE = 1;
// Значок места доски `RpChat`
const PIN_PATH = 'M12 21s-6-6-6-11a6 6 0 0 1 12 0c0 5-6 11-6 11zM12 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z';

const callParvane = callApi as unknown as (method: string, args?: unknown) => Promise<unknown>;

// Экран «Место» (доска `RpChat`): карта со своей точкой (тайлы — через свой сервер, MAP-1), «Отправить текущее
// место» с точностью, трансляция на 15 минут / 1 час / 8 часов и точка вручную «широта, долгота»
const LocationScreen = ({ isOpen, chatId, onClose }: OwnProps) => {
  const lang = useLang();
  const [position, setPosition] = useState<Position>();
  const [isLocating, setIsLocating] = useState(false);
  const [period, setPeriod] = useState<Period>('3600');
  const [manual, setManual] = useState('');
  const [error, setError] = useState<string>();

  // Место запрашивается при открытии экрана, до первого кадра
  useLayoutEffect(() => {
    if (!isOpen) return;
    setManual('');
    setError(undefined);
    setPosition(undefined);
    if (!navigator.geolocation) {
      setError(lang('LocationUnavailable'));
      return;
    }
    setIsLocating(true);
    navigator.geolocation.getCurrentPosition((pos) => {
      setIsLocating(false);
      const { heading, accuracy } = pos.coords;
      setPosition({
        lat: pos.coords.latitude,
        long: pos.coords.longitude,
        accuracy: accuracy ? Math.round(accuracy) : undefined,
        heading: typeof heading === 'number' && !Number.isNaN(heading) ? Math.round(heading) : undefined,
      });
    }, () => {
      setIsLocating(false);
      setError(lang('LocationUnavailable'));
    }, { enableHighAccuracy: true });
  }, [isOpen, lang]);

  const mapHash = position
    ? buildStaticMapHash({ lat: position.lat, long: position.long, accessHash: '0' }, MAP_WIDTH, MAP_HEIGHT, MAP_ZOOM,
      MAP_SCALE)
    : undefined;
  const mapUrl = useMedia(mapHash);

  const send = useLastCallback((point: Position, livePeriod?: number) => {
    const chat = getGlobal().chats.byId[chatId];
    if (!chat) return;
    void callParvane('parvaneSendLocation', {
      chat,
      lat: point.lat,
      long: point.long,
      period: livePeriod,
      heading: livePeriod ? point.heading : undefined,
      accuracy: point.accuracy,
    });
    onClose();
  });

  const handleSendCurrent = useLastCallback(() => {
    if (position) send(position);
  });

  const handleStartLive = useLastCallback(() => {
    if (position) send(position, Number(period));
  });

  const handleManualChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setManual(e.currentTarget.value);
    setError(undefined);
  });

  // Enter сразу после ввода приходит раньше отрисовки — значение берётся из поля
  const handleSendManual = useLastCallback((typed: string) => {
    const point = parseCoordinates(typed);
    if (!point) {
      setError(lang('LocationManualInvalid'));
      return;
    }
    send(point);
  });

  const handleManualKeyDown = useLastCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    handleSendManual(e.currentTarget.value);
  });

  const periodItems = PERIODS.map((value) => ({ value, label: lang(PERIOD_KEYS[value]) }));
  const accuracyText = position?.accuracy
    ? lang('LocationAccuracy', { meters: position.accuracy })
    : lang(isLocating ? 'LocationLocating' : 'LocationUnknown');

  return (
    <ChatScreen isOpen={isOpen} title={lang('LocationScreenTitle')} onClose={onClose}>
      <div className={styles.map} role="img" aria-label={lang('LocationMapLabel')} data-location-map>
        {mapUrl && <img className={styles.mapImage} src={mapUrl} alt="" draggable={false} />}
        <span className={buildClassName(styles.dot, !position && styles.dotIdle)} />
      </div>
      <div className={screen.grp}>
        <button
          type="button"
          className={buildClassName(screen.sr, screen.srButton)}
          disabled={!position}
          data-location-send
          onClick={handleSendCurrent}
        >
          <svg className={buildClassName(kit.icon, styles.pinIcon)} viewBox="0 0 24 24" aria-hidden="true">
            <path d={PIN_PATH} />
          </svg>
          <span className={screen.srMain}>
            <span className={styles.rowTitle}>{lang('LocationSendCurrent')}</span>
            <span className={styles.rowSub}>{accuracyText}</span>
          </span>
        </button>
      </div>
      <div className={screen.cap}>{lang('LocationShareFor')}</div>
      <div className={styles.padX}>
        <PvSegment items={periodItems} value={period} label={lang('LocationShareFor')} onChange={setPeriod} />
      </div>
      <div className={screen.pad}>
        <button
          type="button"
          className={screen.btn}
          disabled={!position}
          data-location-live
          onClick={handleStartLive}
        >
          {lang(START_KEYS[period])}
        </button>
      </div>
      <div className={screen.hint}>{lang('LocationHint')}</div>
      <div className={screen.cap}>{lang('LocationManual')}</div>
      <div className={styles.padX}>
        <label className={screen.fld}>
          {lang('LocationManualLabel')}
          <input
            className={buildClassName(screen.inp, screen.mono)}
            type="text"
            inputMode="decimal"
            placeholder="41.3111, 69.2797"
            value={manual}
            data-location-manual
            onChange={handleManualChange}
            onKeyDown={handleManualKeyDown}
          />
        </label>
      </div>
      {error && <p className={buildClassName(screen.error, styles.error)} role="alert">{error}</p>}
    </ChatScreen>
  );
};

export default memo(LocationScreen);
