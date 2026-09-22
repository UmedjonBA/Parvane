// Фоновая проверка целостности потокового E2E-медиа (решение 2026-09-15,
// spec 002 FR-022). Плеер получает окна сразу (AES-CTR без тега), а здесь весь
// шифртекст файла докачивается пакетами и прогоняется через проверку тега GCM.
// Инварианты:
//  - первый полученный экземпляр фрагмента — эталон (SHA-256); тот же индекс с
//    другими байтами (для плеера или для проверки) = подмена;
//  - размер из облака сверяется с размером из E2E-контента сообщения;
//  - одна активная задача на клиент, пакет — пока нет запросов окон плеера;
//  - после провала файл навсегда (в сессии) отдаёт MEDIA_INTEGRITY.

export type FileGeometry = { sizeBytes: number; chunkBytes: number; totalChunks: number };

export type StreamingVerifier = {
  update: (bytes: Uint8Array) => void | Promise<void>;
  finish: () => boolean | Promise<boolean>;
  dispose?: () => void;
};

type IntegrityDependencies = {
  fetchChunks: (fileId: string, from: number, to: number) => Promise<Map<number, Uint8Array> | undefined>;
  createVerifier: (fileId: string, geometry: FileGeometry) => Promise<StreamingVerifier | undefined>;
  onTampered: (fileId: string, reason: string) => void;
  onVerified?: (fileId: string) => void;
  // Проверку довести не удалось (сеть/шард): файл не подменён, но и не проверен
  onUnverifiable?: (fileId: string, reason: string) => void;
  log?: (message: string) => void;
  schedule?: (callback: () => void, ms: number) => unknown;
  cancelSchedule?: (handle: unknown) => void;
  digest?: (bytes: Uint8Array) => Promise<string>;
};

type IntegrityOptions = {
  startDelayMs?: number;
  idleMs?: number;
  batchChunks?: number;
  resumeMs?: number;
};

type JobState = 'idle' | 'waiting' | 'verifying' | 'paused' | 'verified' | 'tampered';

type Job = {
  fileId: string;
  state: JobState;
  geometry?: FileGeometry;
  digests: Map<number, string>;
  verifier?: StreamingVerifier;
  nextIndex: number;
  startTimer?: unknown;
  idleTimer?: unknown;
  resumeTimer?: unknown;
  resumeAttempts: number;
  // Момент настоящего старта воспроизведения (событие `play` у <video>)
  playbackStartedAt?: number;
  lastTouch: number;
};

const DEFAULT_START_DELAY_MS = 5000;
const DEFAULT_IDLE_MS = 15000;
const DEFAULT_BATCH_CHUNKS = 24;
// Пауза по простою или по сбою сети — только уступка, а не конец: FR-022
// требует докачать и проверить весь файл независимо от того, смотрит ли
// пользователь. Возобновляем сами, с потолком попыток на случай, когда файл
// недоступен насовсем
const DEFAULT_RESUME_MS = 1000;
const MAX_RESUME_ATTEMPTS = 10;
const GCM_TAG_BYTES = 16;

async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createMediaIntegrity(deps: IntegrityDependencies, options: IntegrityOptions = {}) {
  const startDelayMs = options.startDelayMs ?? DEFAULT_START_DELAY_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const batchChunks = Math.max(1, options.batchChunks ?? DEFAULT_BATCH_CHUNKS);
  const resumeMs = options.resumeMs ?? DEFAULT_RESUME_MS;
  const schedule = deps.schedule || ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancelSchedule = deps.cancelSchedule || ((handle: unknown) => clearTimeout(handle as number));
  const digest = deps.digest || sha256Hex;

  const jobs = new Map<string, Job>();
  const tampered = new Set<string>();
  const queue: string[] = [];
  let activeFileId: string | undefined;
  let playerRequests = 0;
  let playerIdleWaiters: Array<() => void> = [];

  function getJob(fileId: string) {
    let job = jobs.get(fileId);
    if (!job) {
      job = {
        fileId, state: 'idle', digests: new Map(), nextIndex: 0, resumeAttempts: 0, lastTouch: Date.now(),
      };
      jobs.set(fileId, job);
    }
    return job;
  }

  // Единственный путь в 'paused': всегда ставит будильник на продолжение,
  // иначе задача зависла бы навсегда (FR-022 требует довести проверку до конца
  // и без открытого плеера)
  function pauseJob(job: Job, reason: string) {
    if (job.state !== 'verifying' && job.state !== 'waiting') return;
    job.state = 'paused';
    if (job.resumeTimer !== undefined) cancelSchedule(job.resumeTimer);
    job.resumeTimer = undefined;
    if (job.resumeAttempts >= MAX_RESUME_ATTEMPTS) {
      // Молчать нельзя: файл не проверен, но и не помечен — UI показывал бы
      // его нормальным вопреки FR-022. Сообщаем наружу как о непроверяемом
      deps.log?.(`целостность ${job.fileId}: пауза (${reason}), попытки исчерпаны`);
      deps.onUnverifiable?.(job.fileId, reason);
      return;
    }
    job.resumeAttempts++;
    // Отступ растёт, чтобы недоступный файл не долбил сеть
    const delay = resumeMs * job.resumeAttempts;
    deps.log?.(`целостность ${job.fileId}: пауза (${reason}), продолжим через ${delay} мс`);
    job.resumeTimer = schedule(() => {
      job.resumeTimer = undefined;
      if (job.state !== 'paused') return;
      job.state = 'waiting';
      enqueue(job.fileId);
    }, delay);
  }

  function markTampered(job: Job, reason: string) {
    if (job.state === 'tampered') return;
    job.state = 'tampered';
    tampered.add(job.fileId);
    if (job.startTimer !== undefined) cancelSchedule(job.startTimer);
    if (job.idleTimer !== undefined) cancelSchedule(job.idleTimer);
    if (job.resumeTimer !== undefined) cancelSchedule(job.resumeTimer);
    job.resumeTimer = undefined;
    job.verifier?.dispose?.();
    job.verifier = undefined;
    deps.log?.(`целостность ${job.fileId}: ${reason}`);
    deps.onTampered(job.fileId, reason);
  }

  // Размер облака против размера из E2E-контента: веб шлёт размер открытого
  // текста (+16 байт тега), десктоп — может прислать размер шифртекста; нет
  // размера — сверки нет
  function noteGeometry(fileId: string, geometry: FileGeometry, expectedPlainSize?: number) {
    const job = getJob(fileId);
    if (job.state === 'tampered') return false;
    if (!job.geometry) {
      if (expectedPlainSize && expectedPlainSize > 0
        && geometry.sizeBytes !== expectedPlainSize + GCM_TAG_BYTES
        && geometry.sizeBytes !== expectedPlainSize) {
        markTampered(job, `размер облака ${geometry.sizeBytes} не сходится с сообщением ${expectedPlainSize}`);
        return false;
      }
      if (geometry.sizeBytes < GCM_TAG_BYTES || geometry.chunkBytes <= 0
        || geometry.totalChunks !== Math.max(1, Math.ceil(geometry.sizeBytes / geometry.chunkBytes))) {
        markTampered(job, 'некорректная геометрия файла');
        return false;
      }
      job.geometry = geometry;
      return true;
    }
    const same = job.geometry.sizeBytes === geometry.sizeBytes
      && job.geometry.chunkBytes === geometry.chunkBytes
      && job.geometry.totalChunks === geometry.totalChunks;
    if (!same) markTampered(job, 'геометрия файла изменилась между ответами');
    return same;
  }

  async function noteChunk(fileId: string, index: number, bytes: Uint8Array) {
    const job = getJob(fileId);
    if (job.state === 'tampered') return false;
    const hash = await digest(bytes);
    const known = job.digests.get(index);
    if (known === undefined) {
      job.digests.set(index, hash);
      return true;
    }
    if (known !== hash) {
      markTampered(job, `фрагмент ${index} пришёл с другими байтами`);
      return false;
    }
    return true;
  }

  function beginPlayerRequest() {
    playerRequests++;
  }

  function endPlayerRequest() {
    playerRequests = Math.max(0, playerRequests - 1);
    if (!playerRequests) {
      const waiters = playerIdleWaiters;
      playerIdleWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }

  function waitPlayerIdle() {
    if (!playerRequests) return Promise.resolve();
    return new Promise<void>((resolve) => {
      playerIdleWaiters.push(resolve);
    });
  }

  function armIdleTimer(job: Job) {
    if (job.idleTimer !== undefined) cancelSchedule(job.idleTimer);
    job.idleTimer = schedule(() => {
      job.idleTimer = undefined;
      if (job.state === 'verifying' || job.state === 'waiting') {
        if (job.startTimer !== undefined) cancelSchedule(job.startTimer);
        job.startTimer = undefined;
        pauseJob(job, 'простой');
      }
    }, idleMs);
  }

  // Плеер действительно начал играть (событие `play` у <video>). SC-003 мерит
  // пять секунд от НАЧАЛА ВОСПРОИЗВЕДЕНИЯ, а не от первого запроса окна: у
  // файла с moov в конце метаданные тянутся дольше, и фоновая докачка успевала
  // стартовать до старта плеера, попадая в замер «загружено до старта ≤ 25 %».
  // Отодвигаем старт, если воспроизведение началось позже первого окна
  function notePlaybackStarted(fileId: string) {
    const job = jobs.get(fileId);
    if (!job || job.state === 'tampered' || job.state === 'verified') return;
    // Отметку ставим один раз: событие `play` прилетает и при каждом
    // возобновлении после паузы, иначе старт проверки отодвигался бы вечно
    if (job.playbackStartedAt !== undefined) return;
    job.playbackStartedAt = Date.now();
    // Если задача уже пошла (метаданные тянулись дольше startDelayMs — ровно
    // случай moov в конце файла), возвращаем её в ожидание: SC-003 мерит пять
    // секунд ОТ НАЧАЛА ВОСПРОИЗВЕДЕНИЯ, и пакеты докачки не должны попадать
    // в замер «загружено до старта»
    if (job.state === 'verifying') {
      job.state = 'waiting';
    } else if (job.state !== 'waiting') {
      return;
    }
    if (job.startTimer !== undefined) cancelSchedule(job.startTimer);
    job.startTimer = schedule(() => {
      job.startTimer = undefined;
      if (job.state !== 'waiting') return;
      enqueue(job.fileId);
    }, startDelayMs);
  }

  // Плеер запросил окно файла (не миниатюру): старт задачи через startDelayMs,
  // продление простоя
  function touch(fileId: string) {
    const job = getJob(fileId);
    job.lastTouch = Date.now();
    if (job.state === 'tampered' || job.state === 'verified') return;
    armIdleTimer(job);
    if (job.state === 'verifying' || job.state === 'waiting') return;
    job.state = 'waiting';
    job.startTimer = schedule(() => {
      job.startTimer = undefined;
      if (job.state !== 'waiting') return;
      enqueue(job.fileId);
    }, startDelayMs);
  }

  function enqueue(fileId: string) {
    if (!queue.includes(fileId)) queue.push(fileId);
    void pump();
  }

  async function pump() {
    if (activeFileId) return;
    const fileId = queue.shift();
    if (!fileId) return;
    const job = jobs.get(fileId);
    if (!job || job.state !== 'waiting') {
      void pump();
      return;
    }
    activeFileId = fileId;
    job.state = 'verifying';
    try {
      await runJob(job);
    } catch (error) {
      deps.log?.(`целостность ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
      if (job.state === 'verifying') pauseJob(job, 'ошибка');
    } finally {
      activeFileId = undefined;
      void pump();
    }
  }

  async function runJob(job: Job) {
    if (!job.geometry) {
      const first = await deps.fetchChunks(job.fileId, 0, 0);
      if (job.state !== 'verifying') return;
      if (!first || !job.geometry) {
        pauseJob(job, 'нет геометрии файла');
        return;
      }
    }
    const geometry = job.geometry;
    if (!job.verifier) {
      job.verifier = await deps.createVerifier(job.fileId, geometry);
      job.nextIndex = 0;
      if (!job.verifier) {
        pauseJob(job, 'верификатор не создан');
        return;
      }
    }
    while (job.state === 'verifying' && job.nextIndex < geometry.totalChunks) {
      await waitPlayerIdle();
      if (job.state !== 'verifying') return;
      const from = job.nextIndex;
      const to = Math.min(geometry.totalChunks - 1, from + batchChunks - 1);
      const fetched = await deps.fetchChunks(job.fileId, from, to);
      if (job.state !== 'verifying') return;
      if (!fetched) {
        pauseJob(job, 'пакет фрагментов не пришёл');
        return;
      }
      for (let index = from; index <= to; index++) {
        const bytes = fetched.get(index);
        if (!bytes) {
          pauseJob(job, `фрагмент ${index} не пришёл`);
          return;
        }
        if (!await noteChunk(job.fileId, index, bytes)) return;
        const isLast = index === geometry.totalChunks - 1;
        const expectedLength = isLast
          ? geometry.sizeBytes - geometry.chunkBytes * (geometry.totalChunks - 1)
          : geometry.chunkBytes;
        if (bytes.length !== expectedLength) {
          markTampered(job, `фрагмент ${index}: ${bytes.length} байт вместо ${expectedLength}`);
          return;
        }
        await job.verifier.update(bytes);
        job.nextIndex = index + 1;
        // Есть прогресс — прошлые сбои не в счёт, иначе длинный файл с редкими
        // обрывами упёрся бы в потолок попыток
        job.resumeAttempts = 0;
      }
    }
    if (job.state !== 'verifying' || job.nextIndex < geometry.totalChunks) return;
    const ok = await job.verifier.finish();
    job.verifier.dispose?.();
    job.verifier = undefined;
    if (!ok) {
      markTampered(job, 'тег GCM не сошёлся');
      return;
    }
    job.state = 'verified';
    if (job.idleTimer !== undefined) cancelSchedule(job.idleTimer);
    deps.log?.(`целостность ${job.fileId}: проверено`);
    deps.onVerified?.(job.fileId);
  }

  // Проверка целого файла прошла/провалилась вне фоновой задачи (короткое
  // видео целиком в кэше, обычная загрузка файла)
  function reportTampered(fileId: string, reason: string) {
    markTampered(getJob(fileId), reason);
  }

  function reportVerified(fileId: string) {
    const job = getJob(fileId);
    if (job.state === 'tampered') return;
    if (job.startTimer !== undefined) cancelSchedule(job.startTimer);
    if (job.idleTimer !== undefined) cancelSchedule(job.idleTimer);
    if (job.resumeTimer !== undefined) cancelSchedule(job.resumeTimer);
    job.resumeTimer = undefined;
    job.verifier?.dispose?.();
    job.verifier = undefined;
    job.state = 'verified';
  }

  function cancel(fileId: string) {
    const job = jobs.get(fileId);
    if (!job) return;
    if (job.startTimer !== undefined) cancelSchedule(job.startTimer);
    job.startTimer = undefined;
    if (job.resumeTimer !== undefined) cancelSchedule(job.resumeTimer);
    job.resumeTimer = undefined;
    if (job.state !== 'verifying' && job.state !== 'waiting') return;
    // Явная остановка: возобновления не планируем, но верификатор освобождаем,
    // иначе потоковый GCM висит в воркере до конца сессии
    job.state = 'paused';
    job.verifier?.dispose?.();
    job.verifier = undefined;
  }

  function reset() {
    jobs.forEach((job) => {
      if (job.startTimer !== undefined) cancelSchedule(job.startTimer);
      if (job.idleTimer !== undefined) cancelSchedule(job.idleTimer);
      if (job.resumeTimer !== undefined) cancelSchedule(job.resumeTimer);
      // Выполняющаяся задача должна выйти из циклов сама: иначе она продолжит
      // качать фрагменты уже с токеном НОВОГО аккаунта и может показать ему
      // чужое «медиа подменено»
      if (job.state === 'verifying' || job.state === 'waiting') job.state = 'paused';
      job.verifier?.dispose?.();
      job.verifier = undefined;
    });
    jobs.clear();
    tampered.clear();
    queue.length = 0;
    playerRequests = 0;
    // Ожидающих простоя плеера ОБЯЗАТЕЛЬНО разрезолвить: брошенный resolver
    // навсегда оставлял `runJob` висеть на `await waitPlayerIdle()`, `finally`
    // в `pump` не выполнялся, `activeFileId` не освобождался — и вся фоновая
    // проверка молча переставала работать до перезагрузки вкладки
    const waiters = playerIdleWaiters;
    playerIdleWaiters = [];
    waiters.forEach((resolve) => resolve());
    activeFileId = undefined;
  }

  return {
    noteGeometry,
    noteChunk,
    touch,
    notePlaybackStarted,
    cancel,
    reset,
    beginPlayerRequest,
    endPlayerRequest,
    reportTampered,
    reportVerified,
    isTampered: (fileId: string) => tampered.has(fileId),
    isVerified: (fileId: string) => jobs.get(fileId)?.state === 'verified',
    stateOf: (fileId: string): JobState => jobs.get(fileId)?.state || 'idle',
  };
}

export type MediaIntegrity = ReturnType<typeof createMediaIntegrity>;
