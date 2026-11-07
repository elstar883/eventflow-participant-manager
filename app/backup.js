import {
  DEFAULT_EVENT,
  STATUS_VALUES,
  TICKET_VALUES,
  MAX_NAME_LENGTH,
  MAX_COMPANY_LENGTH,
  normalizeEmail,
  isValidEmail,
} from './db.js';

export const BACKUP_SCHEMA_VERSION = 1;

const MAX_ERRORS_IN_DETAILS = 12;

export class BackupError extends Error {
  constructor(message, { details = [], code = 'backup' } = {}) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Создаёт документ резервной копии из снимка IndexedDB.
 * В файл попадают только поля схемы, без служебных ключей хранилища settings.
 */
export function createBackupDocument({ event, participants, activity } = {}, exportedAt = new Date()) {
  const exportedDate = exportedAt instanceof Date ? exportedAt : new Date(exportedAt);
  const safeExportedAt = Number.isNaN(exportedDate.getTime())
    ? new Date().toISOString()
    : exportedDate.toISOString();
  const sourceEvent = isPlainObject(event) ? event : {};
  const capacity = Number(sourceEvent.capacity);

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: safeExportedAt,
    event: {
      name: normalizeText(sourceEvent.name) || DEFAULT_EVENT.name,
      venue: normalizeText(sourceEvent.venue) || DEFAULT_EVENT.venue,
      capacity: Number.isFinite(capacity) && capacity >= 0 ? capacity : DEFAULT_EVENT.capacity,
    },
    participants: (Array.isArray(participants) ? participants : []).map((participant) => ({
      id: typeof participant?.id === 'string' ? participant.id : '',
      name: normalizeText(participant?.name),
      email: normalizeEmail(participant?.email),
      company: normalizeText(participant?.company),
      ticket: typeof participant?.ticket === 'string' ? participant.ticket : '',
      status: typeof participant?.status === 'string' ? participant.status : '',
      checkedIn: participant?.checkedIn === true,
      registeredAt: typeof participant?.registeredAt === 'string' ? participant.registeredAt : '',
      archivedAt: typeof participant?.archivedAt === 'string' ? participant.archivedAt : null,
      updatedAt: typeof participant?.updatedAt === 'string' ? participant.updatedAt : null,
    })),
    activity: (Array.isArray(activity) ? activity : []).map((entry) => ({
      id: typeof entry?.id === 'string' ? entry.id : '',
      type: typeof entry?.type === 'string' ? entry.type : '',
      message: typeof entry?.message === 'string' ? entry.message : '',
      participantId: typeof entry?.participantId === 'string' ? entry.participantId : null,
      createdAt: typeof entry?.createdAt === 'string' ? entry.createdAt : '',
      meta: isPlainObject(entry?.meta) ? entry.meta : {},
    })),
  };
}

/**
 * Полностью проверяет JSON резервной копии до любой записи в IndexedDB.
 * Возвращает нормализованные данные либо выбрасывает BackupError.
 */
export function validateBackupDocument(document) {
  if (!isPlainObject(document)) {
    throw new BackupError('Файл не является объектом резервной копии EventFlow.', {
      code: 'backup_structure',
    });
  }

  if (!Object.prototype.hasOwnProperty.call(document, 'schemaVersion')) {
    throw new BackupError('В файле нет поля schemaVersion. Это не резервная копия EventFlow.', {
      code: 'backup_structure',
    });
  }

  if (document.schemaVersion !== BACKUP_SCHEMA_VERSION) {
    throw new BackupError(
      `Версия резервной копии ${String(document.schemaVersion)} не поддерживается. ` +
      `Ожидается schemaVersion ${BACKUP_SCHEMA_VERSION}.`,
      { code: 'backup_version' },
    );
  }

  const errors = [];
  const exportedAt = normalizeDate(document.exportedAt);
  if (!exportedAt) {
    errors.push('Поле exportedAt должно содержать корректную дату в ISO-формате.');
  }

  const event = validateEvent(document.event, errors);

  if (!Array.isArray(document.participants)) {
    errors.push('Поле participants должно быть массивом участников.');
  }

  if (!Array.isArray(document.activity)) {
    errors.push('Поле activity должно быть массивом записей журнала.');
  }

  const participants = [];
  if (Array.isArray(document.participants)) {
    const ids = new Set();
    const emails = new Set();

    document.participants.forEach((record, index) => {
      const participant = validateParticipant(record, index, errors, ids, emails);
      if (participant) {
        participants.push(participant);
      }
    });
  }

  const activity = [];
  if (Array.isArray(document.activity)) {
    const ids = new Set();

    document.activity.forEach((record, index) => {
      const entry = validateActivityEntry(record, index, errors, ids);
      if (entry) {
        activity.push(entry);
      }
    });
  }

  if (errors.length > 0) {
    throw new BackupError(
      `Файл не прошёл проверку: ${errors.length} ${pluralizeErrors(errors.length)}.`,
      {
        code: 'backup_structure',
        details: errors.slice(0, MAX_ERRORS_IN_DETAILS),
      },
    );
  }

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt,
    event,
    participants,
    activity,
  };
}

function validateEvent(source, errors) {
  if (!isPlainObject(source)) {
    errors.push('Поле event должно быть объектом с настройками события.');
    return null;
  }

  const name = normalizeText(source.name);
  if (!name) {
    errors.push('В event не указано название события.');
  } else if (name.length > 200) {
    errors.push('Название события в event длиннее 200 символов.');
  }

  let venue = DEFAULT_EVENT.venue;
  if (source.venue !== undefined) {
    if (typeof source.venue !== 'string') {
      errors.push('Поле event.venue должно быть строкой.');
    } else {
      venue = normalizeText(source.venue) || DEFAULT_EVENT.venue;
    }
  }

  let capacity = DEFAULT_EVENT.capacity;
  if (source.capacity !== undefined) {
    const value = Number(source.capacity);
    if (!Number.isFinite(value) || value < 0) {
      errors.push('Поле event.capacity должно быть неотрицательным числом.');
    } else {
      capacity = value;
    }
  }

  return { name, venue, capacity };
}

function validateParticipant(record, index, errors, ids, emails) {
  const label = `Участник ${index + 1}`;
  const start = errors.length;

  if (!isPlainObject(record)) {
    errors.push(`${label}: ожидается объект участника.`);
    return null;
  }

  const id = normalizeText(record.id);
  if (!id) {
    errors.push(`${label}: не указан id.`);
  } else if (ids.has(id)) {
    errors.push(`${label}: id повторяется.`);
  } else {
    ids.add(id);
  }

  const name = normalizeText(record.name);
  if (!name) {
    errors.push(`${label}: не указано имя.`);
  } else if (name.length > MAX_NAME_LENGTH) {
    errors.push(`${label}: имя длиннее ${MAX_NAME_LENGTH} символов.`);
  }

  const email = normalizeEmail(record.email);
  if (!email) {
    errors.push(`${label}: не указан email.`);
  } else if (!isValidEmail(email)) {
    errors.push(`${label}: некорректный email «${String(record.email).trim()}».`);
  } else if (emails.has(email)) {
    errors.push(`${label}: email повторяется без учёта регистра.`);
  } else {
    emails.add(email);
  }

  let company = '';
  if (record.company !== undefined && record.company !== null) {
    if (typeof record.company !== 'string') {
      errors.push(`${label}: поле company должно быть строкой.`);
    } else {
      company = normalizeText(record.company);
      if (company.length > MAX_COMPANY_LENGTH) {
        errors.push(`${label}: название компании длиннее ${MAX_COMPANY_LENGTH} символов.`);
      }
    }
  }

  const ticket = typeof record.ticket === 'string' ? record.ticket : '';
  if (!TICKET_VALUES.includes(ticket)) {
    errors.push(`${label}: недопустимый тип билета.`);
  }

  const status = typeof record.status === 'string' ? record.status : '';
  if (!STATUS_VALUES.includes(status)) {
    errors.push(`${label}: недопустимый статус.`);
  }

  if (typeof record.checkedIn !== 'boolean') {
    errors.push(`${label}: checkedIn должен быть true или false.`);
  }

  const checkedIn = record.checkedIn === true;
  if (checkedIn && status !== 'confirmed') {
    errors.push(`${label}: checkedIn = true допустим только для статуса confirmed.`);
  }

  const registeredAt = normalizeDate(record.registeredAt);
  if (!registeredAt) {
    errors.push(`${label}: некорректная или пустая дата регистрации.`);
  }

  const archivedAt = normalizeNullableDate(record.archivedAt);
  if (record.archivedAt !== null && record.archivedAt !== undefined && !archivedAt) {
    errors.push(`${label}: некорректная дата архивации.`);
  }

  const updatedAt = normalizeNullableDate(record.updatedAt);
  if (record.updatedAt !== null && record.updatedAt !== undefined && !updatedAt) {
    errors.push(`${label}: некорректная дата обновления.`);
  }

  if (errors.length > start) {
    return null;
  }

  return {
    id,
    name,
    email,
    company,
    ticket,
    status,
    checkedIn,
    registeredAt,
    archivedAt,
    updatedAt: updatedAt ?? archivedAt ?? registeredAt,
  };
}

function validateActivityEntry(record, index, errors, ids) {
  const label = `Запись журнала ${index + 1}`;
  const start = errors.length;

  if (!isPlainObject(record)) {
    errors.push(`${label}: ожидается объект записи.`);
    return null;
  }

  const id = normalizeText(record.id);
  if (!id) {
    errors.push(`${label}: не указан id.`);
  } else if (ids.has(id)) {
    errors.push(`${label}: id повторяется.`);
  } else {
    ids.add(id);
  }

  const type = normalizeText(record.type);
  if (!type) {
    errors.push(`${label}: не указан type.`);
  }

  const message = normalizeText(record.message);
  if (!message) {
    errors.push(`${label}: не указано сообщение.`);
  }

  let participantId = null;
  if (record.participantId !== null && record.participantId !== undefined) {
    if (typeof record.participantId !== 'string') {
      errors.push(`${label}: participantId должен быть строкой или null.`);
    } else {
      participantId = normalizeText(record.participantId) || null;
    }
  }

  const createdAt = normalizeDate(record.createdAt);
  if (!createdAt) {
    errors.push(`${label}: некорректная или пустая дата createdAt.`);
  }

  let meta = {};
  if (record.meta !== undefined) {
    if (!isPlainObject(record.meta)) {
      errors.push(`${label}: поле meta должно быть объектом.`);
    } else {
      meta = record.meta;
    }
  }

  if (errors.length > start) {
    return null;
  }

  return {
    id,
    type,
    message,
    participantId,
    createdAt,
    meta,
  };
}

function normalizeDate(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  const time = Date.parse(value.trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function normalizeNullableDate(value) {
  if (value === null || value === undefined) {
    return null;
  }

  return normalizeDate(value);
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pluralizeErrors(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'ошибка';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'ошибки';
  }

  return 'ошибок';
}
