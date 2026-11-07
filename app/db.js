export const DB_NAME = 'eventflow-db';
export const DB_VERSION = 1;

export const STORE_PARTICIPANTS = 'participants';
export const STORE_SETTINGS = 'settings';
export const STORE_ACTIVITY = 'activity';

// Синхронизировано с data/event-settings.json.
// Приложение не читает data/ во время работы: источником истины после первого
// запуска является хранилище settings в IndexedDB.
export const DEFAULT_EVENT = Object.freeze({
  name: 'Практикум «Продукты с ИИ»',
  venue: 'Учебный центр',
  capacity: 120,
});

export const STATUSES = Object.freeze([
  Object.freeze({ value: 'new', label: 'Новый' }),
  Object.freeze({ value: 'confirmed', label: 'Подтверждён' }),
  Object.freeze({ value: 'waitlist', label: 'Лист ожидания' }),
  Object.freeze({ value: 'cancelled', label: 'Отменён' }),
]);

export const TICKETS = Object.freeze([
  Object.freeze({ value: 'standard', label: 'Стандартный' }),
  Object.freeze({ value: 'business', label: 'Бизнес' }),
  Object.freeze({ value: 'vip', label: 'VIP' }),
]);

export const STATUS_VALUES = Object.freeze(STATUSES.map((status) => status.value));
export const TICKET_VALUES = Object.freeze(TICKETS.map((ticket) => ticket.value));

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MAX_NAME_LENGTH = 120;
export const MAX_COMPANY_LENGTH = 160;

export class DatabaseError extends Error {
  constructor(message, { cause = null, code = 'database' } = {}) {
    super(message);
    this.name = 'DatabaseError';
    this.code = code;
    if (cause) {
      this.cause = cause;
    }
  }
}

export class ValidationError extends Error {
  constructor(errors, message = 'Проверьте заполнение формы.') {
    super(message);
    this.name = 'ValidationError';
    this.code = 'validation';
    this.errors = errors;
  }
}

let dbPromise = null;

export function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  const promise = new Promise((resolve, reject) => {
    let settled = false;

    const fail = (error, code) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new DatabaseError('Не удалось открыть локальную базу данных EventFlow.', { cause: error, code }));
    };

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      fail(error, 'unsupported');
      return;
    }

    request.onupgradeneeded = (event) => {
      upgradeDatabase(request.result, event.oldVersion);
    };

    request.onsuccess = () => {
      const db = request.result;

      if (settled) {
        db.close();
        return;
      }

      db.onversionchange = () => {
        db.close();
        dbPromise = null;
        window.dispatchEvent(new CustomEvent('eventflow-db-versionchange'));
      };

      ensureSettings(db)
        .then(() => {
          if (settled) {
            db.close();
            return;
          }
          settled = true;
          resolve(db);
        })
        .catch((error) => {
          db.close();
          fail(error, 'settings');
        });
    };

    request.onerror = () => {
      fail(request.error, 'open');
    };

    request.onblocked = () => {
      fail(new Error('База данных заблокирована другой вкладкой.'), 'blocked');
    };
  });

  dbPromise = promise.catch((error) => {
    dbPromise = null;
    throw error;
  });

  return dbPromise;
}

export async function getSnapshot() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(
        [STORE_PARTICIPANTS, STORE_SETTINGS, STORE_ACTIVITY],
        'readonly',
      );
    } catch (error) {
      reject(new DatabaseError('Не удалось прочитать данные EventFlow.', { cause: error, code: 'read' }));
      return;
    }

    const participantsRequest = transaction.objectStore(STORE_PARTICIPANTS).getAll();
    const settingsRequest = transaction.objectStore(STORE_SETTINGS).get('event');
    const activityRequest = transaction.objectStore(STORE_ACTIVITY).getAll();

    let participants = [];
    let activity = [];
    let event = null;

    participantsRequest.onsuccess = () => {
      participants = Array.isArray(participantsRequest.result) ? participantsRequest.result : [];
    };

    settingsRequest.onsuccess = () => {
      event = settingsRequest.result ?? null;
    };

    activityRequest.onsuccess = () => {
      activity = Array.isArray(activityRequest.result) ? activityRequest.result : [];
    };

    transaction.oncomplete = () => {
      resolve({ event, participants, activity });
    };

    transaction.onerror = () => {
      reject(new DatabaseError('Не удалось прочитать данные EventFlow.', {
        cause: transaction.error,
        code: 'read',
      }));
    };

    transaction.onabort = () => {
      reject(new DatabaseError('Чтение данных EventFlow было прервано.', {
        cause: transaction.error,
        code: 'read',
      }));
    };
  });
}

export function closeDatabase() {
  const current = dbPromise;
  dbPromise = null;

  if (!current) {
    return Promise.resolve();
  }

  return current
    .then((db) => {
      db.close();
    })
    .catch(() => {
      // Соединение уже закрыто или не было открыто.
    });
}

function upgradeDatabase(db, oldVersion) {
  // Версия 1 — первая схема приложения. Миграции данных с предыдущих версий нет:
  // при обновлении с 0 создаются все хранилища и индексы.
  if (oldVersion < 1) {
    if (!db.objectStoreNames.contains(STORE_PARTICIPANTS)) {
      const participants = db.createObjectStore(STORE_PARTICIPANTS, { keyPath: 'id' });
      participants.createIndex('email', 'email', { unique: true });
      participants.createIndex('status', 'status', { unique: false });
      participants.createIndex('registeredAt', 'registeredAt', { unique: false });
      participants.createIndex('archivedAt', 'archivedAt', { unique: false });
    }

    if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
      db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
    }

    if (!db.objectStoreNames.contains(STORE_ACTIVITY)) {
      db.createObjectStore(STORE_ACTIVITY, { keyPath: 'id' });
    }
  }
}

function ensureSettings(db) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(STORE_SETTINGS, 'readwrite');
    } catch (error) {
      reject(new DatabaseError('Не удалось подготовить настройки события.', {
        cause: error,
        code: 'settings',
      }));
      return;
    }

    const store = transaction.objectStore(STORE_SETTINGS);
    const request = store.get('event');

    request.onsuccess = () => {
      if (request.result) {
        return;
      }

      try {
        store.put({
          key: 'event',
          ...DEFAULT_EVENT,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        transaction.abort();
        reject(new DatabaseError('Не удалось сохранить настройки события.', {
          cause: error,
          code: 'settings',
        }));
      }
    };

    transaction.oncomplete = () => {
      resolve();
    };

    transaction.onerror = () => {
      reject(new DatabaseError('Не удалось сохранить настройки события.', {
        cause: transaction.error,
        code: 'settings',
      }));
    };

    transaction.onabort = () => {
      reject(new DatabaseError('Сохранение настроек события было прервано.', {
        cause: transaction.error,
        code: 'settings',
      }));
    };
  });
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

/**
 * Приводит дату регистрации из CSV к ISO-строке.
 * Возвращает null, если значение пустое или не разбирается как дата.
 */
export function normalizeRegisteredAt(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const time = Date.parse(value.trim());
  if (Number.isNaN(time)) {
    return null;
  }

  return new Date(time).toISOString();
}

/**
 * Проверяет черновик формы и возвращает { errors, value }.
 * Ошибки привязаны к именам полей формы.
 */
export function validateParticipantDraft(draft, participants = [], currentId = null) {
  const source = draft && typeof draft === 'object' ? draft : {};
  const errors = {};

  const name = typeof source.name === 'string' ? source.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) {
    errors.name = 'Укажите имя участника.';
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.name = `Имя не должно быть длиннее ${MAX_NAME_LENGTH} символов.`;
  }

  const email = normalizeEmail(source.email);
  if (!email) {
    errors.email = 'Укажите email.';
  } else if (!EMAIL_PATTERN.test(email)) {
    errors.email = 'Введите email в формате name@example.com.';
  } else if (participants.some((item) => item.id !== currentId && normalizeEmail(item.email) === email)) {
    errors.email = 'Этот email уже используется другим участником.';
  }

  const company = typeof source.company === 'string' ? source.company.trim().replace(/\s+/g, ' ') : '';
  if (company.length > MAX_COMPANY_LENGTH) {
    errors.company = `Название компании не должно быть длиннее ${MAX_COMPANY_LENGTH} символов.`;
  }

  const status = STATUS_VALUES.includes(source.status) ? source.status : null;
  if (!status) {
    errors.status = 'Выберите статус из списка.';
  }

  const ticket = TICKET_VALUES.includes(source.ticket) ? source.ticket : null;
  if (!ticket) {
    errors.ticket = 'Выберите тип билета из списка.';
  }

  // Отметка о приходе допустима только для подтверждённого участника.
  const checkedIn = status === 'confirmed' && source.checkedIn === true;

  return {
    errors,
    value: { name, email, company, ticket, status, checkedIn },
  };
}

export async function saveParticipant(draft, { id = null } = {}) {
  const db = await openDatabase();

  return performTransaction(db, [STORE_PARTICIPANTS, STORE_ACTIVITY], (transaction, abort) => {
    const participantsStore = transaction.objectStore(STORE_PARTICIPANTS);
    const activityStore = transaction.objectStore(STORE_ACTIVITY);
    const request = participantsStore.getAll();
    let saved = null;

    request.onsuccess = () => {
      const participants = Array.isArray(request.result) ? request.result : [];
      const current = id ? participants.find((item) => item.id === id) : null;

      if (id && !current) {
        abort(new DatabaseError('Участник не найден. Возможно, запись уже изменили в другой вкладке.', {
          code: 'not_found',
        }));
        return;
      }

      const { errors, value } = validateParticipantDraft(draft, participants, id);
      if (Object.keys(errors).length > 0) {
        abort(new ValidationError(errors));
        return;
      }

      const now = new Date().toISOString();
      saved = current
        ? { ...current, ...value, updatedAt: now }
        : { id: createId(), ...value, registeredAt: now, archivedAt: null, updatedAt: now };

      try {
        participantsStore.put(saved);
      } catch (error) {
        abort(new ValidationError({
          email: 'Этот email уже используется другим участником.',
        }));
        return;
      }

      activityStore.put(createActivity(
        current ? 'participant_updated' : 'participant_added',
        current ? `Обновлены данные участника: ${saved.name}` : `Добавлен участник: ${saved.name}`,
        saved.id,
      ));
    };

    request.onerror = () => {
      abort(new DatabaseError('Не удалось проверить список участников.', {
        cause: request.error,
        code: 'write',
      }));
    };

    return () => saved;
  });
}

export async function archiveParticipant(id) {
  const db = await openDatabase();

  return performTransaction(db, [STORE_PARTICIPANTS, STORE_ACTIVITY], (transaction, abort) => {
    const participantsStore = transaction.objectStore(STORE_PARTICIPANTS);
    const activityStore = transaction.objectStore(STORE_ACTIVITY);
    const request = participantsStore.get(id);
    let saved = null;

    request.onsuccess = () => {
      const participant = request.result;
      if (!participant) {
        abort(new DatabaseError('Участник не найден. Возможно, запись уже изменили в другой вкладке.', {
          code: 'not_found',
        }));
        return;
      }

      if (participant.archivedAt) {
        saved = participant;
        return;
      }

      const now = new Date().toISOString();
      saved = { ...participant, archivedAt: now, updatedAt: now };

      try {
        participantsStore.put(saved);
      } catch (error) {
        abort(new DatabaseError('Не удалось отправить участника в архив.', {
          cause: error,
          code: 'write',
        }));
        return;
      }

      activityStore.put(createActivity(
        'archived',
        `Участник отправлен в архив: ${saved.name}`,
        saved.id,
      ));
    };

    request.onerror = () => {
      abort(new DatabaseError('Не удалось прочитать участника.', {
        cause: request.error,
        code: 'write',
      }));
    };

    return () => saved;
  });
}

export async function restoreParticipant(id) {
  const db = await openDatabase();

  return performTransaction(db, [STORE_PARTICIPANTS, STORE_ACTIVITY], (transaction, abort) => {
    const participantsStore = transaction.objectStore(STORE_PARTICIPANTS);
    const activityStore = transaction.objectStore(STORE_ACTIVITY);
    const request = participantsStore.get(id);
    let saved = null;

    request.onsuccess = () => {
      const participant = request.result;
      if (!participant) {
        abort(new DatabaseError('Участник не найден. Возможно, запись уже изменили в другой вкладке.', {
          code: 'not_found',
        }));
        return;
      }

      const now = new Date().toISOString();
      const checkedIn = participant.status === 'confirmed' && participant.checkedIn === true;
      saved = { ...participant, archivedAt: null, checkedIn, updatedAt: now };

      try {
        participantsStore.put(saved);
      } catch (error) {
        abort(new DatabaseError('Не удалось восстановить участника из архива.', {
          cause: error,
          code: 'write',
        }));
        return;
      }

      activityStore.put(createActivity(
        'restored',
        `Участник восстановлен из архива: ${saved.name}`,
        saved.id,
      ));
    };

    request.onerror = () => {
      abort(new DatabaseError('Не удалось прочитать участника.', {
        cause: request.error,
        code: 'write',
      }));
    };

    return () => saved;
  });
}

export async function setParticipantCheckIn(id, checkedIn) {
  const db = await openDatabase();

  return performTransaction(db, [STORE_PARTICIPANTS, STORE_ACTIVITY], (transaction, abort) => {
    const participantsStore = transaction.objectStore(STORE_PARTICIPANTS);
    const activityStore = transaction.objectStore(STORE_ACTIVITY);
    const request = participantsStore.get(id);
    let saved = null;

    request.onsuccess = () => {
      const participant = request.result;
      if (!participant) {
        abort(new DatabaseError('Участник не найден. Возможно, запись уже изменили в другой вкладке.', {
          code: 'not_found',
        }));
        return;
      }

      if (participant.archivedAt) {
        abort(new DatabaseError('Участник находится в архиве. Сначала восстановите запись.', {
          code: 'archived',
        }));
        return;
      }

      if (checkedIn && participant.status !== 'confirmed') {
        abort(new DatabaseError('Отметить приход можно только подтверждённому участнику.', {
          code: 'checkin_not_allowed',
        }));
        return;
      }

      const now = new Date().toISOString();
      saved = { ...participant, checkedIn: checkedIn === true, updatedAt: now };

      try {
        participantsStore.put(saved);
      } catch (error) {
        abort(new DatabaseError('Не удалось изменить отметку о приходе.', {
          cause: error,
          code: 'write',
        }));
        return;
      }

      activityStore.put(createActivity(
        saved.checkedIn ? 'check_in' : 'check_out',
        saved.checkedIn
          ? `Отмечен приход: ${saved.name}`
          : `Снята отметка о приходе: ${saved.name}`,
        saved.id,
      ));
    };

    request.onerror = () => {
      abort(new DatabaseError('Не удалось прочитать участника.', {
        cause: request.error,
        code: 'write',
      }));
    };

    return () => saved;
  });
}

/**
 * Импортирует заранее проверенные строки CSV одной транзакцией.
 * Внутри транзакции повторно проверяет email и допустимость полей:
 * строки, которые перестали быть корректными, пропускаются.
 */
export async function importParticipants(rows) {
  const db = await openDatabase();
  const candidates = Array.isArray(rows) ? rows : [];

  return performTransaction(db, [STORE_PARTICIPANTS, STORE_ACTIVITY], (transaction, abort) => {
    const participantsStore = transaction.objectStore(STORE_PARTICIPANTS);
    const activityStore = transaction.objectStore(STORE_ACTIVITY);
    const request = participantsStore.getAll();
    let result = { imported: 0, skipped: candidates.length, total: candidates.length };

    request.onsuccess = () => {
      const participants = Array.isArray(request.result) ? request.result : [];
      const knownEmails = new Set(participants.map((item) => normalizeEmail(item.email)));
      const now = new Date().toISOString();
      let imported = 0;
      let skipped = 0;

      for (const candidate of candidates) {
        const draft = {
          name: candidate?.name,
          email: candidate?.email,
          company: candidate?.company,
          ticket: candidate?.ticket,
          status: candidate?.status,
          checkedIn: candidate?.checkedIn === true,
        };
        const email = normalizeEmail(draft.email);
        const registeredAt = normalizeRegisteredAt(candidate?.registeredAt);

        if (!email || knownEmails.has(email) || !registeredAt) {
          skipped += 1;
          continue;
        }

        // checked_in = true допустим только для статуса confirmed.
        if (draft.checkedIn && draft.status !== 'confirmed') {
          skipped += 1;
          continue;
        }

        const { errors, value } = validateParticipantDraft(draft, participants, null);
        if (Object.keys(errors).length > 0) {
          skipped += 1;
          continue;
        }

        const saved = {
          id: createId(),
          ...value,
          registeredAt,
          archivedAt: null,
          updatedAt: now,
        };

        try {
          participantsStore.put(saved);
        } catch (error) {
          abort(new DatabaseError('Не удалось записать участника при импорте.', {
            cause: error,
            code: 'write',
          }));
          return;
        }

        knownEmails.add(email);
        imported += 1;
      }

      result = { imported, skipped, total: candidates.length };
      activityStore.put(createActivity(
        'imported',
        `Импорт CSV: добавлено ${imported} из ${candidates.length} строк.` +
          (skipped > 0 ? ` Пропущено: ${skipped}.` : ''),
        null,
        { total: candidates.length, imported, skipped },
      ));
    };

    request.onerror = () => {
      abort(new DatabaseError('Не удалось проверить участников перед импортом.', {
        cause: request.error,
        code: 'write',
      }));
    };

    return () => result;
  });
}

/**
 * Записывает факт экспорта резервной копии в журнал действий.
 * Вызывается после скачивания файла, поэтому сбой журнала не блокирует экспорт.
 */
export async function recordBackupExport({ participants = 0, activity = 0 } = {}) {
  const db = await openDatabase();

  return performTransaction(db, [STORE_ACTIVITY], (transaction, abort) => {
    const activityStore = transaction.objectStore(STORE_ACTIVITY);

    try {
      activityStore.put(createActivity(
        'backup_exported',
        `Экспортирована резервная копия: участников ${participants}, действий ${activity}.`,
        null,
        { participants, activity },
      ));
    } catch (error) {
      abort(new DatabaseError('Не удалось записать экспорт в журнал действий.', {
        cause: error,
        code: 'write',
      }));
    }
  });
}

/**
 * Полностью заменяет участников, настройки события и журнал одной транзакцией.
 * Данные должны быть заранее проверены validateBackupDocument из backup.js.
 */
export async function restoreBackup(backup) {
  const db = await openDatabase();
  const event = backup?.event ?? DEFAULT_EVENT;
  const participants = Array.isArray(backup?.participants) ? backup.participants : [];
  const activity = Array.isArray(backup?.activity) ? backup.activity : [];

  return performTransaction(
    db,
    [STORE_PARTICIPANTS, STORE_SETTINGS, STORE_ACTIVITY],
    (transaction, abort) => {
      const participantsStore = transaction.objectStore(STORE_PARTICIPANTS);
      const settingsStore = transaction.objectStore(STORE_SETTINGS);
      const activityStore = transaction.objectStore(STORE_ACTIVITY);
      const now = new Date().toISOString();

      try {
        // Запросы IndexedDB выполняются в порядке постановки в очередь:
        // сначала очищаем хранилища, затем записываем данные из копии.
        participantsStore.clear();
        settingsStore.clear();
        activityStore.clear();

        participants.forEach((participant) => participantsStore.put(participant));
        activity.forEach((entry) => activityStore.put(entry));

        settingsStore.put({
          key: 'event',
          name: event.name,
          venue: event.venue,
          capacity: event.capacity,
          updatedAt: now,
        });

        activityStore.put(createActivity(
          'backup_restored',
          `Восстановлена резервная копия: участников ${participants.length}, действий ${activity.length}.`,
          null,
          { participants: participants.length, activity: activity.length },
        ));
      } catch (error) {
        abort(new DatabaseError('Не удалось восстановить данные из резервной копии.', {
          cause: error,
          code: 'restore',
        }));
      }

      return () => ({
        participants: participants.length,
        activity: activity.length,
      });
    },
  );
}

function performTransaction(db, storeNames, executor) {
  return new Promise((resolve, reject) => {
    let transaction;
    try {
      transaction = db.transaction(storeNames, 'readwrite');
    } catch (error) {
      reject(new DatabaseError('Не удалось начать запись в IndexedDB.', {
        cause: error,
        code: 'write',
      }));
      return;
    }

    let failure = null;
    let settled = false;
    let getResult = null;

    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };

    const abort = (error) => {
      failure = error;
      try {
        transaction.abort();
      } catch (abortError) {
        settle(reject, error);
      }
    };

    transaction.oncomplete = () => {
      settle(resolve, typeof getResult === 'function' ? getResult() : getResult);
    };

    transaction.onerror = () => {
      settle(reject, failure ?? new DatabaseError('Не удалось сохранить изменения в IndexedDB.', {
        cause: transaction.error,
        code: 'write',
      }));
    };

    transaction.onabort = () => {
      settle(reject, failure ?? new DatabaseError('Сохранение изменений было отменено.', {
        cause: transaction.error,
        code: 'write',
      }));
    };

    try {
      getResult = executor(transaction, abort);
    } catch (error) {
      failure = error instanceof DatabaseError || error instanceof ValidationError
        ? error
        : new DatabaseError('Не удалось сохранить изменения в IndexedDB.', { cause: error, code: 'write' });
      try {
        transaction.abort();
      } catch (abortError) {
        settle(reject, failure);
      }
    }
  });
}

function createActivity(type, message, participantId, meta = {}) {
  return {
    id: createId(),
    type,
    message,
    participantId: participantId ?? null,
    createdAt: new Date().toISOString(),
    meta,
  };
}

function createId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
