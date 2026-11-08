// Переключатели приватности (B14 ревью 7 ноя 2026): источник истины — сервер (FR-040). Значение пишется на
// устройство, отправляется серверу, и при отказе (движок не готов, ошибка запроса) прежнее значение возвращается, а
// экран откатывает переключатель с уведомлением — раньше отказ был только в журнале, и тумблер молча «откатывался»
// при следующем открытии

export async function savePrivacySetting<T>(params: {
  read: () => T;
  write: (value: T) => void;
  next: T;
  push: () => Promise<boolean>;
}): Promise<boolean> {
  const previous = params.read();
  params.write(params.next);
  let isSaved: boolean;
  try {
    isSaved = await params.push();
  } catch {
    isSaved = false;
  }
  if (!isSaved) params.write(previous);
  return isSaved;
}
