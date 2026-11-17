// Parvane (spec 038): сводка «Здоровья» из движка (`healthView`, HEALTH-3) и разбор ввода (`healthParse`,
// HEALTH-2). Экран эти значения только показывает

export type HealthEntry = {
  id: string;
  kind: string;
  atMs: number;
  endMs: number;
  tzMin: number;
  day: string;
  value: number;
  value2: number;
  unit: string;
  source: string;
  note: string;
};

export type HealthSleepNight = {
  id: string;
  startMs: number;
  endMs: number;
  minutes: number;
  day: string;
  bedMin?: number;
  wakeMin?: number;
};

export type HealthSleepDay = {
  day: string;
  // 0 — понедельник
  weekday: number;
  minutes?: number;
  bedMin?: number;
  wakeMin?: number;
};

export type HealthSleepView = {
  goalBedMin?: number;
  goalWakeMin?: number;
  goalMinutes?: number;
  last?: HealthSleepNight;
  lastTotalMinutes?: number;
  lastDeltaMinutes?: number;
  week: HealthSleepDay[];
  avgMinutes?: number;
  openStartMs?: number;
};

export type HealthMetricView = {
  kind: string;
  unit: string;
  isSum: boolean;
  last?: HealthEntry;
  goal?: number;
  toGoal?: number;
  today?: number;
  weekDelta?: number;
  monthDelta?: number;
  series: { day: string; value: number; value2: number }[];
};

export type HealthView = {
  today: string;
  sleep: HealthSleepView;
  metrics: HealthMetricView[];
  recent: HealthEntry[];
};

// Запись без id: из формы, кнопки либо разбора — id даёт движок (`healthCompose`)
export type HealthDraft = Omit<HealthEntry, 'id' | 'day' | 'note'> & { note?: string };

export type HealthParsedEntry = {
  kind: string;
  atMs: number;
  endMs: number;
  tzMin: number;
  value: number;
  value2: number;
  unit: string;
  source: string;
  day: string;
  time: string;
  endDay?: string;
  endTime?: string;
};

export type HealthParseResult = {
  entries: HealthParsedEntry[];
  unparsed: string[];
  problems: { text: string; code: string }[];
};

export type HealthStatus = 'loading' | 'needs-linking' | 'no-key' | 'offline' | 'ready';
