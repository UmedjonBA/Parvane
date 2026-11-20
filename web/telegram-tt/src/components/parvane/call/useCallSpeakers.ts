import { useEffect, useState } from '../../../lib/teact/teact';

import { measureLevel, updateSpeakers } from './callSpeaking';

const SAMPLE_MS = 200;
const FFT_SIZE = 512;

// Кто говорит: анализатор на звуковую дорожку каждого потока, замер раз в 200 мс. Ключи — как в `streams`
export default function useCallSpeakers(streams: Record<string, MediaStream | undefined>) {
  const [speakers, setSpeakers] = useState<string[]>([]);
  const entries = Object.entries(streams)
    .filter((entry): entry is [string, MediaStream] => Boolean(entry[1]?.getAudioTracks().length));
  const streamsKey = entries.map(([key, stream]) => `${key}:${stream.id}`).join('|');

  useEffect(() => {
    if (!entries.length || typeof AudioContext === 'undefined') {
      setSpeakers([]);
      return undefined;
    }
    const context = new AudioContext();
    void context.resume().catch(() => undefined);
    const meters = entries.map(([key, stream]) => {
      const analyser = context.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      context.createMediaStreamSource(stream).connect(analyser);
      return { key, analyser, samples: new Uint8Array(FFT_SIZE) };
    });
    let lastLoudAt: Record<string, number> = {};
    const timer = window.setInterval(() => {
      const levels: Record<string, number> = {};
      meters.forEach(({ key, analyser, samples }) => {
        analyser.getByteTimeDomainData(samples);
        levels[key] = measureLevel(samples);
      });
      const result = updateSpeakers(levels, lastLoudAt, Date.now());
      lastLoudAt = result.lastLoudAt;
      setSpeakers((current) => (current.join('|') === result.speakers.join('|') ? current : result.speakers));
    }, SAMPLE_MS);
    return () => {
      window.clearInterval(timer);
      void context.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks-static-deps/exhaustive-deps -- пересоздаём только при смене состава потоков
  }, [streamsKey]);

  return speakers;
}
