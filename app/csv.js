import {
  STATUS_VALUES,
  TICKET_VALUES,
  normalizeEmail,
  isValidEmail,
  normalizeRegisteredAt,
  MAX_NAME_LENGTH,
  MAX_COMPANY_LENGTH,
} from './db.js';

// Заголовки синхронизированы с файлами data/participants*.csv.
const ALL_HEADERS = Object.freeze([
  'name',
  'email',
  'company',
  'ticket',
  'status',
  'checked_in',
  'registered_at',
]);
const REQUIRED_HEADERS = Object.freeze(ALL_HEADERS.filter((header) => header !== 'company'));

const TRUE_VALUES = new Set(['true', '1', 'yes', 'да']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'нет']);

export class CsvError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CsvError';
    this.code = 'csv';
  }
}

/**
 * Разбирает CSV в UTF-8: поддерживает BOM, CRLF, кавычки и переводы строк
 * внутри кавычек. Возвращает заголовки и строки с номерами физических строк.
 */
export function parseCsv(text) {
  if (typeof text !== 'string') {
    throw new CsvError('Не удалось прочитать файл как текст.');
  }

  const source = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) {
    throw new CsvError('Файл пуст. Выберите CSV-файл с заголовками и строками участников.');
  }

  const delimiter = detectDelimiter(source);
  const parsedRecords = tokenize(source, delimiter);
  const records = parsedRecords.filter((record) => {
    return record.cells.some((cell) => cell.trim() !== '');
  });

  if (records.length === 0) {
    throw new CsvError('Файл не содержит данных.');
  }

  const headerRecord = records[0];
  const headers = headerRecord.cells.map(normalizeHeader);
  const indexByHeader = new Map();
  const duplicateHeaders = [];

  headers.forEach((header, index) => {
    if (!header) {
      return;
    }

    if (indexByHeader.has(header)) {
      duplicateHeaders.push(header);
      return;
    }

    indexByHeader.set(header, index);
  });

  if (duplicateHeaders.length > 0) {
    throw new CsvError(
      `В заголовке повторяются колонки: ${[...new Set(duplicateHeaders)].join(', ')}. ` +
      'Оставьте по одной колонке каждого типа.',
    );
  }

  const missing = REQUIRED_HEADERS.filter((header) => !indexByHeader.has(header));
  if (missing.length > 0) {
    throw new CsvError(
      `В файле не хватает обязательных колонок: ${missing.join(', ')}. ` +
      `Ожидаются заголовки: ${ALL_HEADERS.join(', ')}.`,
    );
  }

  const dataRecords = records.slice(1).map((record) => {
    const values = {};
    headers.forEach((header, index) => {
      if (header) {
        values[header] = (record.cells[index] ?? '').trim();
      }
    });
    return { line: record.line, values };
  });

  if (dataRecords.length === 0) {
    throw new CsvError('В файле есть только заголовки. Добавьте строки участников и повторите импорт.');
  }

  return { headers, records: dataRecords, delimiter };
}

/**
 * Проверяет строки CSV без записи в IndexedDB.
 * Возвращает статистику, ошибки по строкам, дубликаты и готовые к импорту записи.
 */
export function analyzeCsv(records, existingParticipants = []) {
  const databaseEmails = new Map();
  existingParticipants.forEach((participant) => {
    const email = normalizeEmail(participant?.email);
    if (email) {
      databaseEmails.set(email, participant);
    }
  });

  const firstLineByEmail = new Map();

  const rows = records.map((record) => {
    const values = record.values ?? {};
    const errors = [];

    const name = normalizeText(values.name);
    const email = normalizeEmail(values.email);
    const company = normalizeText(values.company);
    const ticket = normalizeEnum(values.ticket);
    const status = normalizeEnum(values.status);
    const checkedInRaw = normalizeEnum(values.checked_in);

    if (!name) {
      errors.push('не указано имя');
    } else if (name.length > MAX_NAME_LENGTH) {
      errors.push(`имя длиннее ${MAX_NAME_LENGTH} символов`);
    }

    if (!email) {
      errors.push('не указан email');
    } else if (!isValidEmail(email)) {
      errors.push('некорректный email');
    }

    if (company.length > MAX_COMPANY_LENGTH) {
      errors.push(`название компании длиннее ${MAX_COMPANY_LENGTH} символов`);
    }

    if (!ticket) {
      errors.push('не указан тип билета');
    } else if (!TICKET_VALUES.includes(ticket)) {
      errors.push(`недопустимый тип билета «${values.ticket.trim()}»`);
    }

    if (!status) {
      errors.push('не указан статус');
    } else if (!STATUS_VALUES.includes(status)) {
      errors.push(`недопустимый статус «${values.status.trim()}»`);
    }

    let checkedIn = null;
    if (!checkedInRaw) {
      errors.push('не указано значение checked_in');
    } else if (TRUE_VALUES.has(checkedInRaw)) {
      checkedIn = true;
    } else if (FALSE_VALUES.has(checkedInRaw)) {
      checkedIn = false;
    } else {
      errors.push(`checked_in должен быть true или false, получено «${values.checked_in.trim()}»`);
    }

    const registeredAt = normalizeRegisteredAt(values.registered_at);
    if (!registeredAt) {
      errors.push('некорректная или пустая дата регистрации (ожидается ISO, например 2026-08-18T09:20:00Z)');
    }

    if (checkedIn === true && STATUS_VALUES.includes(status) && status !== 'confirmed') {
      errors.push('checked_in = true допустим только для статуса confirmed');
    }

    let duplicate = false;
    if (email && isValidEmail(email)) {
      const firstLine = firstLineByEmail.get(email);

      if (firstLine) {
        duplicate = true;
        errors.push(`дубликат email: в файле уже есть строка ${firstLine}`);
      } else {
        firstLineByEmail.set(email, record.line);
        const existing = databaseEmails.get(email);

        if (existing) {
          duplicate = true;
          errors.push(existing.archivedAt
            ? 'email уже есть в базе (запись в архиве)'
            : 'email уже есть в базе');
        }
      }
    }

    const valid = errors.length === 0;

    return {
      line: record.line,
      values,
      name,
      email,
      company,
      ticket,
      status,
      checkedIn,
      registeredAt,
      errors,
      duplicate,
      valid,
      participant: valid
        ? {
          name,
          email,
          company,
          ticket,
          status,
          checkedIn: checkedIn === true,
          registeredAt,
        }
        : null,
    };
  });

  const validRows = rows.filter((row) => row.valid);

  return {
    rows,
    validRows,
    duplicates: rows.filter((row) => row.duplicate),
    participants: validRows.map((row) => row.participant),
    stats: {
      total: rows.length,
      valid: validRows.length,
      invalid: rows.length - validRows.length,
      duplicates: rows.filter((row) => row.duplicate).length,
    },
  };
}

function detectDelimiter(source) {
  const firstLine = source.split('\n').find((line) => line.trim() !== '') ?? '';
  let comma = 0;
  let semicolon = 0;
  let inQuotes = false;

  for (let index = 0; index < firstLine.length; index += 1) {
    const char = firstLine[index];

    if (char === '"') {
      if (inQuotes && firstLine[index + 1] === '"') {
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (inQuotes) {
      continue;
    }

    if (char === ',') {
      comma += 1;
    } else if (char === ';') {
      semicolon += 1;
    }
  }

  return semicolon > comma ? ';' : ',';
}

function tokenize(source, delimiter) {
  const records = [];
  let cells = [];
  let field = '';
  let line = 1;
  let recordLine = 1;
  let inQuotes = false;
  let afterQuote = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += char;
        if (char === '\n') {
          line += 1;
        }
      }
      continue;
    }

    if (afterQuote) {
      if (char === delimiter) {
        cells.push(field);
        field = '';
        afterQuote = false;
        continue;
      }

      if (char === ' ' || char === '\t') {
        continue;
      }

      if (char === '\n') {
        cells.push(field);
        records.push({ line: recordLine, cells });
        cells = [];
        field = '';
        afterQuote = false;
        line += 1;
        recordLine = line;
        continue;
      }

      throw new CsvError(`Строка ${line}: после закрывающей кавычки ожидался разделитель или перевод строки.`);
    }

    if (char === '"') {
      if (field.trim() === '') {
        field = '';
        inQuotes = true;
      } else {
        field += char;
      }
      continue;
    }

    if (char === delimiter) {
      cells.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      cells.push(field);
      records.push({ line: recordLine, cells });
      cells = [];
      field = '';
      line += 1;
      recordLine = line;
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new CsvError(`Строка ${recordLine}: незакрытая кавычка в поле.`);
  }

  if (field !== '' || cells.length > 0 || afterQuote) {
    cells.push(field);
    records.push({ line: recordLine, cells });
  }

  return records;
}

function normalizeHeader(value) {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function normalizeEnum(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}
