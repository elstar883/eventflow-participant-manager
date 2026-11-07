#!/usr/bin/env node
/*
 * Проверка целостности статического приложения EventFlow.
 *
 * Скрипт не запускает браузер и не требует зависимостей:
 *  - проверяет обязательные файлы и метаданные репозитория;
 *  - разбирает оба CSV-файла тем же кодом, что и приложение;
 *  - сверяет модель события со схемой IndexedDB;
 *  - проверяет демонстрационную резервную копию;
 *  - проверяет разметку, отсутствие внешних ресурсов и сетевых вызовов;
 *  - проверяет синтаксис модулей приложения.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_EVENT,
  STATUSES,
  TICKETS,
  STORE_ACTIVITY,
  STORE_PARTICIPANTS,
  STORE_SETTINGS,
  DB_NAME,
  DB_VERSION,
} from "../app/db.js";
import { parseCsv, analyzeCsv } from "../app/csv.js";
import { validateBackupDocument } from "../app/backup.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFile(join(root, path), "utf8");

const errors = [];
const check = (condition, message) => {
  if (!condition) {
    errors.push(message);
  }
};

const readJson = async (path) => JSON.parse(await read(path));

/* ---------- Обязательные файлы ---------- */

const requiredFiles = [
  "app/index.html",
  "app/styles.css",
  "app/app.js",
  "app/db.js",
  "app/csv.js",
  "app/backup.js",
  "data/event-settings.json",
  "data/participants.csv",
  "data/participants-with-errors.csv",
  "references/project-brief.md",
  "references/acceptance-checklist.md",
  "docs/ARCHITECTURE.md",
  "docs/DATA-MODEL.md",
  "docs/QA-CHECKLIST.md",
  "docs/examples/backup-sample.json",
  "docs/images/eventflow-hero.png",
  "docs/images/eventflow-desktop.png",
  "docs/images/eventflow-import-preview.png",
  "docs/images/eventflow-mobile-hero.png",
  "docs/images/eventflow-mobile.png",
  "README.md",
  "LICENSE",
  "AGENTS.md",
  "package.json",
  "scripts/validate.mjs",
];

for (const file of requiredFiles) {
  try {
    await read(file);
  } catch {
    check(false, `нет обязательного файла: ${file}`);
  }
}

/* ---------- Метаданные репозитория ---------- */

const packageJson = await readJson("package.json");
check(packageJson.type === "module", 'в package.json должно быть "type": "module"');
check(packageJson.version === "1.0.0", "версия package.json должна быть 1.0.0");
check(packageJson.license === "MIT", "лицензия в package.json должна быть MIT");
check(
  !packageJson.dependencies && !packageJson.devDependencies,
  "у приложения не должно быть npm-зависимостей",
);
check(
  packageJson.scripts?.check === "node scripts/validate.mjs",
  "в package.json должен быть скрипт check",
);

const gitignore = await read(".gitignore");
for (const pattern of [".DS_Store", ".env", "*.zip", "*.pdf"]) {
  check(gitignore.includes(pattern), `.gitignore должен исключать ${pattern}`);
}

for (const artifact of ["app.zip", "lesson-7-eventflow-starter.zip", ".DS_Store", ".env"]) {
  try {
    await read(artifact);
    check(false, `в репозитории не должно быть ${artifact}`);
  } catch {
    // Файла нет — это ожидаемо.
  }
}

/* ---------- Настройки события и схема ---------- */

const settings = await readJson("data/event-settings.json");

check(settings.event?.name === DEFAULT_EVENT.name, "название события не совпадает с db.js");
check(settings.event?.venue === DEFAULT_EVENT.venue, "площадка события не совпадает с db.js");
check(settings.event?.capacity === DEFAULT_EVENT.capacity, "вместимость события не совпадает с db.js");
check(
  JSON.stringify(settings.statuses) === JSON.stringify(STATUSES),
  "статусы в data/event-settings.json не совпадают с db.js",
);
check(
  JSON.stringify(settings.tickets) === JSON.stringify(TICKETS),
  "типы билетов в data/event-settings.json не совпадают с db.js",
);

check(DB_NAME === "eventflow-db", "имя IndexedDB должно быть eventflow-db");
check(DB_VERSION === 1, "версия схемы IndexedDB должна быть 1");
check(STORE_PARTICIPANTS === "participants", "хранилище участников должно называться participants");
check(STORE_SETTINGS === "settings", "хранилище настроек должно называться settings");
check(STORE_ACTIVITY === "activity", "хранилище журнала должно называться activity");

const dbSource = await read("app/db.js");
for (const index of ["email", "status", "registeredAt", "archivedAt"]) {
  check(
    dbSource.includes(`createIndex('${index}'`),
    `в схеме IndexedDB нет индекса ${index}`,
  );
}
check(
  dbSource.includes("createIndex('email', 'email', { unique: true })"),
  "индекс email должен быть уникальным",
);
check(dbSource.includes("indexedDB.open"), "app/db.js должен открывать базу через indexedDB.open");

/* ---------- CSV-наборы ---------- */

const mainCsv = parseCsv(await read("data/participants.csv"));
const main = analyzeCsv(mainCsv.records);

check(
  JSON.stringify(main.stats) === JSON.stringify({ total: 12, valid: 12, invalid: 0, duplicates: 0 }),
  `data/participants.csv: ожидается 12 корректных строк, получено ${JSON.stringify(main.stats)}`,
);

const statusCounts = {};
const ticketCounts = {};
for (const row of main.validRows) {
  statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
  ticketCounts[row.ticket] = (ticketCounts[row.ticket] ?? 0) + 1;
}

check(
  JSON.stringify(statusCounts) ===
    JSON.stringify({ confirmed: 6, new: 3, waitlist: 2, cancelled: 1 }),
  `неожиданное распределение статусов: ${JSON.stringify(statusCounts)}`,
);
check(
  JSON.stringify(ticketCounts) === JSON.stringify({ vip: 3, standard: 5, business: 4 }),
  `неожиданное распределение билетов: ${JSON.stringify(ticketCounts)}`,
);
check(
  main.validRows.filter((row) => row.checkedIn).length === 3,
  "в основном наборе должно быть 3 отмеченных прихода",
);

const mainEmails = new Set(main.validRows.map((row) => row.email));
check(mainEmails.size === 12, "email в data/participants.csv должны быть уникальны");
for (const email of mainEmails) {
  check(/@example\.(ru|com)$/i.test(email), `email ${email} не выглядит синтетическим`);
}

const errorCsv = parseCsv(await read("data/participants-with-errors.csv"));
const errorAnalysis = analyzeCsv(
  errorCsv.records,
  main.validRows.map((row) => row.participant),
);

check(
  JSON.stringify(errorAnalysis.stats) ===
    JSON.stringify({ total: 8, valid: 2, invalid: 6, duplicates: 2 }),
  `data/participants-with-errors.csv: ожидается 8/2/6/2, получено ${JSON.stringify(errorAnalysis.stats)}`,
);

const expectedErrorLines = new Map([
  [3, "некорректный email"],
  [4, "не указано имя"],
  [5, "email уже есть в базе"],
  [6, "недопустимый статус"],
  [7, "checked_in = true допустим только для статуса confirmed"],
  [8, "дубликат email"],
]);

for (const [line, reason] of expectedErrorLines) {
  const row = errorAnalysis.rows.find((item) => item.line === line);
  check(Boolean(row), `в data/participants-with-errors.csv нет строки ${line}`);
  check(
    Boolean(row?.errors.some((message) => message.includes(reason))),
    `строка ${line}: ожидается ошибка «${reason}»`,
  );
}

check(
  errorAnalysis.validRows.every((row) => row.checkedIn === false || row.status === "confirmed"),
  "check-in должен быть допустим только для статуса confirmed",
);

/* ---------- Демонстрационная резервная копия ---------- */

const backup = validateBackupDocument(await readJson("docs/examples/backup-sample.json"));
const activeParticipants = backup.participants.filter((participant) => !participant.archivedAt);

check(backup.schemaVersion === 1, "schemaVersion примера должен быть 1");
check(backup.participants.length === 15, "в примере должно быть 15 участников");
check(activeParticipants.length === 14, "в примере должно быть 14 активных участников");
check(backup.participants.length - activeParticipants.length === 1, "в примере должен быть 1 архивный участник");
check(backup.activity.length === 4, "в примере должно быть 4 записи журнала");
check(
  backup.participants.filter((participant) => participant.status === "confirmed").length === 7,
  "в примере должно быть 7 подтверждённых участников",
);
check(
  backup.participants.filter((participant) => participant.checkedIn === true).length === 3,
  "в примере должно быть 3 отмеченных прихода",
);
check(
  new Set(backup.participants.map((participant) => participant.email)).size === 15,
  "email в примере должны быть уникальны",
);
check(
  new Set(backup.participants.map((participant) => participant.id)).size === 15,
  "id в примере должны быть уникальны",
);
for (const participant of backup.participants) {
  check(
    /@example\.(ru|com)$/i.test(participant.email),
    `email ${participant.email} в примере не выглядит синтетическим`,
  );
  check(
    !participant.checkedIn || participant.status === "confirmed",
    `участник ${participant.email}: check-in допустим только для confirmed`,
  );
}

/* ---------- Разметка и статические ограничения ---------- */

const html = await read("app/index.html");
const requiredIds = [
  "event-name",
  "metric-total",
  "metric-confirmed",
  "metric-arrived",
  "metric-waitlist",
  "search",
  "status-filter",
  "ticket-filter",
  "sort-order",
  "reset-filters",
  "add-participant",
  "import-csv",
  "export-json",
  "restore-json",
  "table-region",
  "activity-list",
  "participant-dialog",
  "details-dialog",
  "import-dialog",
  "restore-dialog",
  "csv-file",
  "json-file",
  "toast-region",
];

for (const id of requiredIds) {
  check(html.includes(`id="${id}"`), `в app/index.html нет элемента #${id}`);
}

check(
  html.includes('type="module"') && html.includes('src="app.js"'),
  "app/index.html должен подключать app.js как модуль",
);
check(html.includes("styles.css"), "app/index.html должен подключать styles.css");
check(
  !/(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(html),
  "app/index.html не должен загружать внешние ресурсы",
);
check(
  !/<script(?![^>]*\bsrc=)/i.test(html),
  "app/index.html не должен содержать встроенных скриптов",
);

const css = await read("app/styles.css");
check(!/@import/i.test(css), "app/styles.css не должен использовать @import");
check(
  !/url\(\s*["']?(?:https?:)?\/\//i.test(css),
  "app/styles.css не должен загружать внешние ресурсы",
);
check(
  /prefers-reduced-motion/i.test(css),
  "app/styles.css должен учитывать prefers-reduced-motion",
);

const appFiles = ["app/app.js", "app/db.js", "app/csv.js", "app/backup.js"];
for (const file of appFiles) {
  const code = await read(file);
  check(
    !/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|import\s*\(/.test(code),
    `${file} не должен обращаться к сети или использовать динамические импорты`,
  );
  check(!/\blocalStorage\b|\bsessionStorage\b/.test(code), `${file} не должен использовать Storage API`);
}

const appSource = await read("app/app.js");
for (const id of ["getSnapshot", "saveParticipant", "archiveParticipant", "restoreParticipant"]) {
  check(appSource.includes(id), `app/app.js должен использовать ${id}`);
}
check(appSource.includes("parseCsv") && appSource.includes("analyzeCsv"), "app/app.js должен использовать CSV-модуль");
check(
  appSource.includes("createBackupDocument") && appSource.includes("validateBackupDocument"),
  "app/app.js должен использовать модуль резервных копий",
);

/* ---------- README и документация ---------- */

const readme = await read("README.md");
for (const heading of ["Быстрый старт", "Скриншоты", "Данные", "Лицензия"]) {
  check(readme.includes(heading), `в README.md нет раздела «${heading}»`);
}

const imageLinks = [...readme.matchAll(/!\[[^\]]*\]\((docs\/images\/[^)]+)\)/g)].map((match) => match[1]);
check(imageLinks.length >= 3, "README.md должен показывать скриншоты приложения");
for (const link of imageLinks) {
  try {
    await read(link);
  } catch {
    check(false, `в README.md ссылка на отсутствующий файл: ${link}`);
  }
}

const architecture = await read("docs/ARCHITECTURE.md");
check(architecture.includes("IndexedDB"), "docs/ARCHITECTURE.md должен описывать IndexedDB");
const dataModel = await read("docs/DATA-MODEL.md");
check(dataModel.includes("schemaVersion"), "docs/DATA-MODEL.md должен описывать схему резервной копии");
const qaChecklist = await read("docs/QA-CHECKLIST.md");
check(qaChecklist.includes("validate.mjs"), "docs/QA-CHECKLIST.md должен ссылаться на validate.mjs");

/* ---------- Синтаксис модулей ---------- */

for (const file of appFiles) {
  const result = spawnSync(process.execPath, ["--check", join(root, file)], {
    encoding: "utf8",
  });
  check(
    result.status === 0,
    `синтаксис ${file} не проходит node --check: ${(result.stderr || "").trim()}`,
  );
}

/* ---------- Итог ---------- */

if (errors.length > 0) {
  console.error(`Проверка не пройдена: ${errors.length} ошибок.`);
  for (const error of errors) {
    console.error(`  - ${error}`);
  }
  process.exit(1);
}

console.log(
  `OK: ${main.stats.valid} участников в основном CSV, ` +
    `${errorAnalysis.stats.invalid} ошибок и ${errorAnalysis.stats.duplicates} дубликатов ` +
    `в демонстрационном CSV, ${backup.participants.length} участников в примере копии.`,
);
