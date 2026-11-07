import {
  getSnapshot,
  saveParticipant,
  archiveParticipant,
  restoreParticipant,
  setParticipantCheckIn,
  importParticipants,
  recordBackupExport,
  restoreBackup,
  validateParticipantDraft,
  ValidationError,
  DEFAULT_EVENT,
  STATUSES,
  TICKETS,
} from './db.js';
import { parseCsv, analyzeCsv, CsvError } from './csv.js';
import { createBackupDocument, validateBackupDocument, BackupError } from './backup.js';

const elements = {
  eventName: document.getElementById('event-name'),
  eventMeta: document.getElementById('event-meta'),
  metrics: document.querySelector('.metrics'),
  metricTotal: document.getElementById('metric-total'),
  metricConfirmed: document.getElementById('metric-confirmed'),
  metricArrived: document.getElementById('metric-arrived'),
  metricWaitlist: document.getElementById('metric-waitlist'),
  resultSummary: document.getElementById('result-summary'),
  search: document.getElementById('search'),
  statusFilter: document.getElementById('status-filter'),
  ticketFilter: document.getElementById('ticket-filter'),
  sortOrder: document.getElementById('sort-order'),
  resetFilters: document.getElementById('reset-filters'),
  addParticipant: document.getElementById('add-participant'),
  tableRegion: document.getElementById('table-region'),
  activityCount: document.getElementById('activity-count'),
  activityList: document.getElementById('activity-list'),
  toastRegion: document.getElementById('toast-region'),
  participantDialog: document.getElementById('participant-dialog'),
  participantForm: document.getElementById('participant-form'),
  participantTitle: document.getElementById('participant-dialog-title'),
  participantSubtitle: document.getElementById('participant-dialog-subtitle'),
  participantSubmit: document.getElementById('participant-submit'),
  participantFormError: document.getElementById('participant-form-error'),
  fieldName: document.getElementById('participant-name'),
  fieldEmail: document.getElementById('participant-email'),
  fieldCompany: document.getElementById('participant-company'),
  fieldTicket: document.getElementById('participant-ticket'),
  fieldStatus: document.getElementById('participant-status'),
  fieldCheckedIn: document.getElementById('participant-checked-in'),
  fieldCheckedInHint: document.getElementById('participant-checked-in-hint'),
  detailsDialog: document.getElementById('details-dialog'),
  detailsTitle: document.getElementById('details-title'),
  detailsBody: document.getElementById('details-body'),
  detailsActions: document.getElementById('details-actions'),
  importCsv: document.getElementById('import-csv'),
  csvFileInput: document.getElementById('csv-file'),
  importDialog: document.getElementById('import-dialog'),
  importForm: document.getElementById('import-form'),
  importSubtitle: document.getElementById('import-dialog-subtitle'),
  importBody: document.getElementById('import-body'),
  importError: document.getElementById('import-error'),
  importSubmit: document.getElementById('import-submit'),
  importCancel: document.getElementById('import-cancel'),
  exportJson: document.getElementById('export-json'),
  exportJsonLabel: document.getElementById('export-json-label'),
  restoreJson: document.getElementById('restore-json'),
  restoreJsonLabel: document.getElementById('restore-json-label'),
  jsonFileInput: document.getElementById('json-file'),
  restoreDialog: document.getElementById('restore-dialog'),
  restoreForm: document.getElementById('restore-form'),
  restoreSubtitle: document.getElementById('restore-dialog-subtitle'),
  restoreBody: document.getElementById('restore-body'),
  restoreError: document.getElementById('restore-error'),
  restoreSubmit: document.getElementById('restore-submit'),
  restoreBack: document.getElementById('restore-back'),
  restoreCancel: document.getElementById('restore-cancel'),
};

const formFields = [
  ['name', 'participant-name', 'participant-name-error'],
  ['email', 'participant-email', 'participant-email-error'],
  ['company', 'participant-company', 'participant-company-error'],
  ['ticket', 'participant-ticket', 'participant-ticket-error'],
  ['status', 'participant-status', 'participant-status-error'],
];

const state = {
  event: null,
  participants: [],
  activity: [],
  loading: true,
  error: null,
  filters: {
    query: '',
    status: '',
    ticket: '',
    sort: 'registered-desc',
  },
};

const formState = {
  mode: 'create',
  id: null,
  touched: new Set(),
  submitting: false,
};

const importState = {
  fileName: '',
  analysis: null,
  busy: false,
  requestId: 0,
};

const exportState = {
  busy: false,
};

const restoreState = {
  fileName: '',
  backup: null,
  stage: 'idle',
  busy: false,
  requestId: 0,
  confirmCheckbox: null,
};

const DEFAULT_TOAST_DURATION = 5000;
const UNDO_TOAST_DURATION = 10000;

const collator = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });
const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});
const dateTimeFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const activityIcons = {
  participant_added: 'icon-user-plus',
  participant_updated: 'icon-edit',
  check_in: 'icon-check',
  check_out: 'icon-clock',
  archived: 'icon-archive',
  restored: 'icon-restore',
  imported: 'icon-upload',
  backup_exported: 'icon-download',
  backup_restored: 'icon-restore',
};

function init() {
  populateFilterOptions();
  populateFormOptions();
  bindEvents();
  loadDashboard();
}

function bindEvents() {
  window.addEventListener('eventflow-db-versionchange', handleVersionChange);

  elements.search.addEventListener('input', handleFilterChange);
  elements.statusFilter.addEventListener('change', handleFilterChange);
  elements.ticketFilter.addEventListener('change', handleFilterChange);
  elements.sortOrder.addEventListener('change', handleFilterChange);
  elements.resetFilters.addEventListener('click', resetFilters);

  elements.addParticipant.addEventListener('click', () => openParticipantForm());
  elements.participantForm.addEventListener('submit', handleFormSubmit);
  elements.participantForm.addEventListener('input', handleFormFieldChange);
  elements.participantForm.addEventListener('change', handleFormFieldChange);

  elements.importCsv.addEventListener('click', handleImportCsvClick);
  elements.csvFileInput.addEventListener('change', handleCsvFileSelected);
  elements.importForm.addEventListener('submit', handleImportSubmit);

  elements.exportJson.addEventListener('click', handleExportJson);
  elements.restoreJson.addEventListener('click', handleRestoreClick);
  elements.jsonFileInput.addEventListener('change', handleJsonFileSelected);
  elements.restoreForm.addEventListener('submit', handleRestoreSubmit);
  elements.restoreBack.addEventListener('click', handleRestoreBack);

  document.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.addEventListener('click', () => {
      const dialog = button.closest('dialog');
      if (dialog) {
        closeDialog(dialog);
        if (dialog === elements.importDialog) {
          resetImportState();
        }
        if (dialog === elements.restoreDialog) {
          resetRestoreState();
        }
      }
    });
  });

  elements.tableRegion.addEventListener('click', handleTableClick);

  [elements.participantDialog, elements.detailsDialog].forEach((dialog) => {
    dialog.addEventListener('close', () => {
      if (dialog === elements.participantDialog) {
        formState.id = null;
        formState.mode = 'create';
        formState.touched = new Set();
        formState.submitted = false;
      }
    });
  });

  elements.importDialog.addEventListener('close', resetImportState);
  elements.importDialog.addEventListener('toggle', (event) => {
    if (event.newState === 'closed') {
      resetImportState();
    }
  });

  elements.restoreDialog.addEventListener('close', resetRestoreState);
  elements.restoreDialog.addEventListener('toggle', (event) => {
    if (event.newState === 'closed') {
      resetRestoreState();
    }
  });
}

async function loadDashboard() {
  state.loading = true;
  state.error = null;
  renderLoading();

  try {
    const snapshot = await getSnapshot();
    state.event = normalizeEvent(snapshot.event);
    state.participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];
    state.activity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
    state.loading = false;
    renderDashboard();
  } catch (error) {
    console.error('EventFlow: не удалось загрузить данные из IndexedDB.', error);
    state.loading = false;
    state.error = error;
    renderError(error);
  }
}

/**
 * Перечитывает IndexedDB после записи и обновляет показатели, таблицу и журнал.
 * Вызывается только после успешной операции записи.
 */
async function refresh() {
  try {
    const snapshot = await getSnapshot();
    state.event = normalizeEvent(snapshot.event);
    state.participants = Array.isArray(snapshot.participants) ? snapshot.participants : [];
    state.activity = Array.isArray(snapshot.activity) ? snapshot.activity : [];
    state.error = null;
    renderDashboard();
    return true;
  } catch (error) {
    console.error('EventFlow: не удалось перечитать данные из IndexedDB.', error);
    state.error = error;
    renderError(error);
    return false;
  }
}

function renderLoading() {
  elements.metrics.setAttribute('aria-busy', 'true');
  elements.tableRegion.setAttribute('aria-busy', 'true');
  elements.activityList.setAttribute('aria-busy', 'true');
  syncHeaderActions();

  elements.eventName.textContent = 'Загрузка события…';
  elements.eventMeta.textContent = 'Читаем настройки из IndexedDB';
  elements.resultSummary.textContent = 'Загружаем участников…';
  elements.activityCount.textContent = '0';

  setMetric(elements.metricTotal, 0);
  setMetric(elements.metricConfirmed, 0);
  setMetric(elements.metricArrived, 0);
  setMetric(elements.metricWaitlist, 0);

  elements.tableRegion.replaceChildren(createTableSkeleton());
  elements.activityList.replaceChildren(createActivitySkeleton());
}

function renderDashboard() {
  renderEventHeader();
  renderMetrics();
  renderParticipants();
  renderActivity();
  syncHeaderActions();

  elements.metrics.setAttribute('aria-busy', 'false');
}

function renderEventHeader() {
  const event = state.event ?? normalizeEvent(null);
  const meta = [event.venue, formatCapacity(event.capacity)].filter(Boolean).join(' · ');

  elements.eventName.textContent = event.name;
  elements.eventMeta.textContent = meta;
  document.title = `${event.name} — EventFlow`;
}

function renderMetrics() {
  const active = state.participants.filter(isActive);

  setMetric(elements.metricTotal, active.length);
  setMetric(elements.metricConfirmed, active.filter((participant) => participant.status === 'confirmed').length);
  setMetric(elements.metricArrived, active.filter((participant) => participant.checkedIn === true).length);
  setMetric(elements.metricWaitlist, active.filter((participant) => participant.status === 'waitlist').length);
}

function renderParticipants() {
  const active = state.participants.filter(isActive);
  const visible = getVisibleParticipants(active);
  const archivedCount = state.participants.length - active.length;
  const filtersActive = hasActiveFilters();

  elements.resultSummary.textContent = buildResultSummary({
    visibleCount: visible.length,
    activeCount: active.length,
    archivedCount,
  });

  elements.resetFilters.disabled = !filtersActive;
  elements.tableRegion.setAttribute('aria-busy', 'false');

  if (visible.length === 0) {
    elements.tableRegion.replaceChildren(createEmptyState({
      archivedCount,
      activeCount: active.length,
      filtersActive,
    }));
    return;
  }

  elements.tableRegion.replaceChildren(createParticipantsTable(visible));
}

function renderActivity() {
  const activity = [...state.activity].sort((left, right) => {
    return toTime(right.createdAt) - toTime(left.createdAt);
  });

  elements.activityCount.textContent = String(activity.length);
  elements.activityList.setAttribute('aria-busy', 'false');

  if (activity.length === 0) {
    elements.activityList.replaceChildren(createActivityEmpty());
    return;
  }

  const list = el('ul', 'activity-list-inner');

  activity.slice(0, 12).forEach((entry) => {
    const item = el('li', 'activity-item');
    const iconWrap = el('span', 'activity-dot');
    iconWrap.append(createIcon(activityIcons[entry.type] ?? 'icon-clock'));

    const body = el('div', 'activity-body');
    const message = el('p', 'activity-message');
    message.textContent = safeText(entry.message, 'Действие');
    const time = el('p', 'activity-time');
    time.textContent = formatDateTime(entry.createdAt);

    body.append(message, time);
    item.append(iconWrap, body);
    list.append(item);
  });

  elements.activityList.replaceChildren(list);
}

function renderError(error, options = {}) {
  const message = getErrorMessage(error);
  const retryLabel = options.retryLabel ?? 'Повторить';
  const retry = options.onRetry ?? loadDashboard;

  elements.metrics.setAttribute('aria-busy', 'false');
  elements.tableRegion.setAttribute('aria-busy', 'false');
  elements.activityList.setAttribute('aria-busy', 'false');
  syncHeaderActions();

  if (state.event) {
    renderEventHeader();
  } else {
    elements.eventName.textContent = 'EventFlow';
    elements.eventMeta.textContent = 'Данные из IndexedDB недоступны';
    document.title = 'EventFlow — управление участниками';
  }

  setMetric(elements.metricTotal, 0);
  setMetric(elements.metricConfirmed, 0);
  setMetric(elements.metricArrived, 0);
  setMetric(elements.metricWaitlist, 0);

  elements.resultSummary.textContent = 'Данные недоступны';
  elements.activityCount.textContent = '0';

  elements.tableRegion.replaceChildren(createErrorState(message, retryLabel, retry));
  elements.activityList.replaceChildren(createActivityEmpty('Журнал недоступен'));
}

function handleVersionChange() {
  closeAllDialogs();
  renderError(new Error('База обновлена в другой вкладке.'), {
    retryLabel: 'Перезагрузить',
    onRetry: () => window.location.reload(),
  });
}

function syncHeaderActions() {
  const unavailable = state.loading || Boolean(state.error);

  elements.exportJson.disabled = unavailable || exportState.busy;
  elements.restoreJson.disabled = unavailable || exportState.busy || restoreState.busy;
  elements.exportJson.setAttribute('aria-busy', String(exportState.busy));
  elements.restoreJson.setAttribute('aria-busy', String(restoreState.busy));
}

function populateFilterOptions() {
  const allStatuses = createOption('', 'Все статусы');
  const statusOptions = STATUSES.map((status) => createOption(status.value, status.label));
  elements.statusFilter.replaceChildren(allStatuses, ...statusOptions);

  const allTickets = createOption('', 'Все билеты');
  const ticketOptions = TICKETS.map((ticket) => createOption(ticket.value, ticket.label));
  elements.ticketFilter.replaceChildren(allTickets, ...ticketOptions);
}

function populateFormOptions() {
  elements.fieldTicket.replaceChildren(
    ...TICKETS.map((ticket) => createOption(ticket.value, ticket.label)),
  );
  elements.fieldStatus.replaceChildren(
    ...STATUSES.map((status) => createOption(status.value, status.label)),
  );
}

function createOption(value, label) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  return option;
}

function createParticipantsTable(participants) {
  const wrap = el('div', 'table-wrap');
  const table = el('table', 'participants-table');
  const caption = el('caption', 'visually-hidden');
  caption.textContent = 'Список активных участников';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');

  ['Участник', 'Билет', 'Статус', 'Регистрация', 'Приход', 'Действия'].forEach((label) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headRow.append(cell);
  });

  head.append(headRow);

  const body = document.createElement('tbody');
  participants.forEach((participant) => {
    const row = document.createElement('tr');

    row.append(
      createParticipantCell(participant),
      createTextCell('Билет', createTicketBadge(participant.ticket)),
      createTextCell('Статус', createStatusChip(participant.status)),
      createDateCell(participant.registeredAt),
      createTextCell('Приход', createCheckin(participant)),
      createActionsCell(participant),
    );

    body.append(row);
  });

  table.append(caption, head, body);
  wrap.append(table);
  return wrap;
}

function createActionsCell(participant) {
  const cell = document.createElement('td');
  cell.dataset.label = 'Действия';

  const wrap = el('div', 'row-actions');
  wrap.append(
    createRowButton({
      action: 'open',
      participant,
      icon: 'icon-eye',
      label: `Открыть карточку: ${participant.name}`,
    }),
    createRowButton({
      action: 'edit',
      participant,
      icon: 'icon-edit',
      label: `Изменить: ${participant.name}`,
    }),
  );

  if (participant.status === 'confirmed') {
    const nextCheckedIn = participant.checkedIn !== true;
    wrap.append(createRowButton({
      action: 'checkin',
      participant,
      icon: 'icon-check',
      label: nextCheckedIn
        ? `Отметить приход: ${participant.name}`
        : `Снять отметку о приходе: ${participant.name}`,
      tone: participant.checkedIn === true ? 'success' : '',
      pressed: participant.checkedIn === true,
    }));
  } else {
    wrap.append(createRowButton({
      action: 'checkin',
      participant,
      icon: 'icon-check',
      label: `Отметить приход: ${participant.name} — доступно только подтверждённым участникам`,
      disabled: true,
    }));
  }

  wrap.append(createRowButton({
    action: 'archive',
    participant,
    icon: 'icon-archive',
    label: `Отправить в архив: ${participant.name}`,
    tone: 'danger',
  }));

  cell.append(wrap);
  return cell;
}

function createRowButton({ action, participant, icon, label, tone = '', pressed = null, disabled = false }) {
  const button = el('button', `icon-btn icon-btn--sm${tone ? ` icon-btn--${tone}` : ''}`);
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = participant.id;
  button.setAttribute('aria-label', label);
  button.title = label;

  if (pressed !== null) {
    button.setAttribute('aria-pressed', String(pressed));
  }

  if (disabled) {
    button.disabled = true;
  }

  button.append(createIcon(icon));
  return button;
}

function createParticipantCell(participant) {
  const cell = document.createElement('td');
  cell.dataset.label = 'Участник';

  const wrap = el('div', 'participant-cell');
  const avatar = el('span', 'avatar');
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = getInitials(participant.name);

  const info = el('div', 'participant-info');
  const name = el('span', 'participant-name');
  name.textContent = safeText(participant.name, 'Без имени');
  const email = el('span', 'participant-email');
  email.textContent = safeText(participant.email, 'Email не указан');
  info.append(name, email);

  if (safeText(participant.company, '')) {
    const company = el('span', 'participant-company');
    company.textContent = participant.company.trim();
    info.append(company);
  }

  wrap.append(avatar, info);
  cell.append(wrap);
  return cell;
}

function createTextCell(label, content) {
  const cell = document.createElement('td');
  cell.dataset.label = label;
  cell.append(content);
  return cell;
}

function createDateCell(value) {
  const cell = document.createElement('td');
  cell.dataset.label = 'Регистрация';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    cell.textContent = '—';
    return cell;
  }

  const time = document.createElement('time');
  time.className = 'time';
  time.dateTime = date.toISOString();
  time.textContent = dateFormatter.format(date);
  cell.append(time);
  return cell;
}

function createTicketBadge(ticket) {
  const label = TICKETS.find((item) => item.value === ticket)?.label ?? 'Не указан';
  const badge = el('span', 'ticket-badge');
  badge.textContent = label;
  return badge;
}

function createStatusChip(status) {
  const statusInfo = STATUSES.find((item) => item.value === status);
  const chip = el('span', `status-chip status-chip--${statusInfo ? status : 'unknown'}`);
  const dot = el('span', 'status-chip__dot');
  dot.setAttribute('aria-hidden', 'true');
  chip.append(dot, document.createTextNode(statusInfo?.label ?? 'Неизвестный статус'));
  return chip;
}

function createCheckin(participant) {
  const checkin = el('span', 'checkin');

  if (participant.status !== 'confirmed') {
    checkin.classList.add('checkin--muted');
    checkin.textContent = 'Недоступно';
    return checkin;
  }

  if (participant.checkedIn === true) {
    checkin.classList.add('checkin--yes');
    checkin.append(createIcon('icon-check'), document.createTextNode('Пришёл'));
    return checkin;
  }

  checkin.classList.add('checkin--no');
  checkin.textContent = 'Не отмечен';
  return checkin;
}

function createEmptyState({ archivedCount = 0, activeCount = 0, filtersActive = false } = {}) {
  const wrap = el('div', 'empty-state');
  const icon = el('div', 'empty-state__icon');

  const title = el('h3');
  const text = el('p');
  const hint = el('p', 'empty-state__hint');
  let action = null;

  if (filtersActive) {
    icon.append(createIcon('icon-search'));
    title.textContent = 'Ничего не найдено';
    text.textContent = 'Ни один участник не подходит под условия поиска и фильтров. Измените запрос или сбросьте условия, чтобы увидеть всех.';
    hint.append(createIcon('icon-info'), document.createTextNode('Поиск идёт по имени, email и компании'));
    action = { label: 'Сбросить условия', icon: 'icon-restore', onClick: resetFilters };
  } else if (activeCount === 0 && archivedCount > 0) {
    icon.append(createIcon('icon-archive'));
    title.textContent = 'Активных участников нет';
    text.textContent = 'Все записи находятся в архиве. Если архивация была только что, вернуть участника можно кнопкой «Отменить» в уведомлении.';
    hint.append(createIcon('icon-database'), document.createTextNode(`В архиве: ${archivedCount}`));
  } else {
    icon.append(createIcon('icon-inbox'));
    title.textContent = 'Пока нет участников';
    text.textContent = 'Добавьте первого участника: после сохранения здесь появятся таблица, показатели и запись в журнале действий.';
    hint.append(createIcon('icon-database'), document.createTextNode('IndexedDB · данные остаются в браузере'));
    action = { label: 'Добавить участника', icon: 'icon-plus', onClick: () => openParticipantForm() };
  }

  wrap.append(icon, title, text);

  if (action) {
    const button = el('button', 'btn btn--primary empty-state__action');
    button.type = 'button';
    button.append(createIcon(action.icon), document.createTextNode(action.label));
    button.addEventListener('click', action.onClick);
    wrap.append(button);
  }

  wrap.append(hint);
  return wrap;
}

function createErrorState(message, retryLabel, onRetry) {
  const wrap = el('div', 'empty-state empty-state--error');
  const icon = el('div', 'empty-state__icon');
  icon.append(createIcon('icon-alert'));

  const title = el('h3');
  title.textContent = 'Не удалось загрузить данные';

  const text = el('p');
  text.textContent = message;

  const retry = el('button', 'btn btn--primary empty-state__action');
  retry.type = 'button';
  retry.append(createIcon('icon-restore'), document.createTextNode(retryLabel));
  retry.addEventListener('click', onRetry);

  const hint = el('p', 'empty-state__hint');
  hint.append(createIcon('icon-info'), document.createTextNode('Проверьте настройки браузера и повторите попытку'));

  wrap.append(icon, title, text, retry, hint);
  return wrap;
}

function createActivityEmpty(message = 'Действий пока нет') {
  const wrap = el('div', 'activity-empty');
  wrap.append(createIcon('icon-clock'));
  const text = el('p');
  text.textContent = message;
  wrap.append(text);
  return wrap;
}

function createTableSkeleton() {
  const wrap = el('div', 'table-skeleton');
  wrap.setAttribute('aria-hidden', 'true');

  for (let rowIndex = 0; rowIndex < 4; rowIndex += 1) {
    const row = el('div', 'skeleton-row');
    for (let cellIndex = 0; cellIndex < 5; cellIndex += 1) {
      row.append(el('span', 'skeleton'));
    }
    wrap.append(row);
  }

  return wrap;
}

function createActivitySkeleton() {
  const wrap = el('div', 'activity-skeleton');
  wrap.setAttribute('aria-hidden', 'true');

  for (let index = 0; index < 4; index += 1) {
    wrap.append(el('span', 'skeleton'));
  }

  return wrap;
}

/* ---------- Поиск, фильтры и сортировка ---------- */

function handleFilterChange() {
  state.filters.query = elements.search.value;
  state.filters.status = elements.statusFilter.value;
  state.filters.ticket = elements.ticketFilter.value;
  state.filters.sort = elements.sortOrder.value;
  renderParticipants();
}

function resetFilters() {
  state.filters.query = '';
  state.filters.status = '';
  state.filters.ticket = '';
  state.filters.sort = 'registered-desc';

  elements.search.value = '';
  elements.statusFilter.value = '';
  elements.ticketFilter.value = '';
  elements.sortOrder.value = 'registered-desc';

  renderParticipants();
  elements.search.focus();
}

function hasActiveFilters() {
  return Boolean(
    state.filters.query.trim()
    || state.filters.status
    || state.filters.ticket,
  );
}

function getVisibleParticipants(active) {
  const query = state.filters.query.trim().toLocaleLowerCase('ru-RU');

  return active
    .filter((participant) => {
      if (state.filters.status && participant.status !== state.filters.status) {
        return false;
      }
      if (state.filters.ticket && participant.ticket !== state.filters.ticket) {
        return false;
      }
      if (!query) {
        return true;
      }
      return [participant.name, participant.email, participant.company].some((value) => {
        return typeof value === 'string' && value.toLocaleLowerCase('ru-RU').includes(query);
      });
    })
    .sort(compareBySort);
}

function compareBySort(left, right) {
  const byName = collator.compare(safeText(left.name, ''), safeText(right.name, ''));
  const byDate = toTime(left.registeredAt) - toTime(right.registeredAt);

  switch (state.filters.sort) {
    case 'name-asc':
      return byName || byDate;
    case 'name-desc':
      return -byName || byDate;
    case 'registered-asc':
      return byDate || byName;
    default:
      return -byDate || byName;
  }
}

function buildResultSummary({ visibleCount, activeCount, archivedCount }) {
  const archiveNote = archivedCount > 0 ? ` · в архиве ${archivedCount}` : '';

  if (activeCount === 0) {
    return archivedCount > 0 ? `Активных нет${archiveNote}` : 'Пока нет участников';
  }

  if (visibleCount === 0) {
    return `Ничего не найдено · активных ${activeCount}${archiveNote}`;
  }

  return `Показано ${visibleCount} из ${activeCount}${archiveNote}`;
}

/* ---------- Действия в таблице ---------- */

function handleTableClick(event) {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) {
    return;
  }

  const participant = state.participants.find((item) => item.id === button.dataset.id);
  if (!participant) {
    return;
  }

  switch (button.dataset.action) {
    case 'open':
      openDetails(participant);
      break;
    case 'edit':
      openParticipantForm(participant);
      break;
    case 'checkin':
      toggleCheckIn(participant);
      break;
    case 'archive':
      handleArchive(participant);
      break;
    default:
      break;
  }
}

function openDetails(participant) {
  elements.detailsTitle.textContent = participant.name;
  elements.detailsBody.replaceChildren(createDetailsList(participant));

  const archiveButton = el('button', 'btn btn--ghost btn--danger');
  archiveButton.type = 'button';
  archiveButton.append(createIcon('icon-archive'), document.createTextNode('В архив'));
  archiveButton.addEventListener('click', () => {
    closeDialog(elements.detailsDialog);
    handleArchive(participant);
  });

  const closeButton = el('button', 'btn btn--secondary');
  closeButton.type = 'button';
  closeButton.textContent = 'Закрыть';
  closeButton.addEventListener('click', () => closeDialog(elements.detailsDialog));

  const editButton = el('button', 'btn btn--primary');
  editButton.type = 'button';
  editButton.append(createIcon('icon-edit'), document.createTextNode('Изменить'));
  editButton.addEventListener('click', () => {
    closeDialog(elements.detailsDialog);
    openParticipantForm(participant);
  });

  elements.detailsActions.replaceChildren(archiveButton, closeButton, editButton);
  openDialog(elements.detailsDialog);
  editButton.focus();
}

function createDetailsList(participant) {
  const list = el('dl', 'details-list');
  const ticketLabel = TICKETS.find((item) => item.value === participant.ticket)?.label ?? 'Не указан';
  const statusLabel = STATUSES.find((item) => item.value === participant.status)?.label ?? 'Неизвестный статус';
  const checkinLabel = participant.status === 'confirmed'
    ? (participant.checkedIn === true ? 'Отмечен' : 'Не отмечен')
    : 'Недоступно для этого статуса';

  [
    ['Email', safeText(participant.email, '—')],
    ['Компания', safeText(participant.company, '—')],
    ['Тип билета', ticketLabel],
    ['Статус', statusLabel],
    ['Дата регистрации', formatDate(participant.registeredAt)],
    ['Приход', checkinLabel],
  ].forEach(([label, value]) => {
    const term = el('dt');
    term.textContent = label;
    const description = el('dd');
    description.textContent = value;
    list.append(term, description);
  });

  return list;
}

async function handleArchive(participant) {
  try {
    await archiveParticipant(participant.id);
    const updated = await refresh();

    if (!updated) {
      return;
    }

    showToast({
      tone: 'info',
      message: `Участник «${participant.name}» отправлен в архив.`,
      actionLabel: 'Отменить',
      duration: UNDO_TOAST_DURATION,
      onAction: () => undoArchive(participant),
    });
  } catch (error) {
    showToast({ tone: 'error', message: getActionErrorMessage(error) });
  }
}

async function undoArchive(participant) {
  try {
    await restoreParticipant(participant.id);
    const updated = await refresh();

    if (updated) {
      showToast({
        tone: 'success',
        message: `Участник «${participant.name}» восстановлен из архива.`,
      });
    }
  } catch (error) {
    showToast({ tone: 'error', message: getActionErrorMessage(error) });
  }
}

async function toggleCheckIn(participant) {
  const nextCheckedIn = participant.checkedIn !== true;

  try {
    await setParticipantCheckIn(participant.id, nextCheckedIn);
    const updated = await refresh();

    if (updated) {
      showToast({
        tone: 'success',
        message: nextCheckedIn
          ? `Приход отмечен: ${participant.name}`
          : `Отметка о приходе снята: ${participant.name}`,
      });
    }
  } catch (error) {
    showToast({ tone: 'error', message: getActionErrorMessage(error) });
  }
}

/* ---------- Форма участника ---------- */

function openParticipantForm(participant = null) {
  formState.mode = participant ? 'edit' : 'create';
  formState.id = participant?.id ?? null;
  formState.touched = new Set();
  formState.submitting = false;

  elements.participantForm.reset();
  elements.participantFormError.hidden = true;
  elements.participantFormError.textContent = '';
  applyErrors({});

  elements.fieldName.value = participant?.name ?? '';
  elements.fieldEmail.value = participant?.email ?? '';
  elements.fieldCompany.value = participant?.company ?? '';
  elements.fieldTicket.value = participant?.ticket ?? TICKETS[0].value;
  elements.fieldStatus.value = participant?.status ?? 'new';
  elements.fieldCheckedIn.checked = participant?.status === 'confirmed' && participant?.checkedIn === true;

  elements.participantTitle.textContent = participant ? 'Редактирование участника' : 'Новый участник';
  elements.participantSubtitle.textContent = participant
    ? `Регистрация: ${formatDate(participant.registeredAt)}. Изменения сохранятся в IndexedDB.`
    : 'Поля со звёздочкой обязательны. Запись сохранится в IndexedDB.';
  elements.participantSubmit.textContent = participant ? 'Сохранить изменения' : 'Добавить участника';

  updateCheckInAvailability();
  syncFormValidation();
  openDialog(elements.participantDialog);
  elements.fieldName.focus();
}

function readFormDraft() {
  return {
    name: elements.fieldName.value,
    email: elements.fieldEmail.value,
    company: elements.fieldCompany.value,
    ticket: elements.fieldTicket.value,
    status: elements.fieldStatus.value,
    checkedIn: elements.fieldCheckedIn.checked,
  };
}

function handleFormFieldChange(event) {
  const field = event.target.name;
  if (field && field !== 'checkedIn') {
    formState.touched.add(field);
  }

  if (event.target === elements.fieldStatus) {
    updateCheckInAvailability();
  }

  syncFormValidation();
}

function updateCheckInAvailability() {
  const isConfirmed = elements.fieldStatus.value === 'confirmed';
  elements.fieldCheckedIn.disabled = !isConfirmed;

  if (!isConfirmed) {
    elements.fieldCheckedIn.checked = false;
  }

  elements.fieldCheckedInHint.textContent = isConfirmed
    ? 'Можно отметить приход подтверждённого участника.'
    : 'Отметка доступна только для статуса «Подтверждён».';
}

function syncFormValidation() {
  const { errors } = validateParticipantDraft(readFormDraft(), state.participants, formState.id);
  const visibleErrors = {};

  formFields.forEach(([field]) => {
    if ((formState.touched.has(field) || formState.submitted) && errors[field]) {
      visibleErrors[field] = errors[field];
    }
  });

  applyErrors(visibleErrors);
  elements.participantSubmit.disabled = formState.submitting
    || Boolean(errors.name || errors.email);

  return errors;
}

function applyErrors(errors) {
  formFields.forEach(([field, inputId, errorId]) => {
    const input = document.getElementById(inputId);
    const errorNode = document.getElementById(errorId);
    const message = errors[field] ?? '';

    if (!input || !errorNode) {
      return;
    }

    errorNode.textContent = message;

    if (message) {
      input.setAttribute('aria-invalid', 'true');
    } else {
      input.removeAttribute('aria-invalid');
    }
  });
}

function focusFirstError(errors) {
  const order = ['name', 'email', 'company', 'ticket', 'status'];
  const field = order.find((key) => errors[key]);
  if (!field) {
    return;
  }

  const entry = formFields.find(([key]) => key === field);
  if (entry) {
    document.getElementById(entry[1])?.focus();
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();

  if (formState.submitting) {
    return;
  }

  formState.submitted = true;
  const draft = readFormDraft();
  const errors = syncFormValidation();

  if (Object.keys(errors).length > 0) {
    applyErrors(errors);
    focusFirstError(errors);
    return;
  }

  const isEdit = Boolean(formState.id);
  setFormBusy(true);

  try {
    const saved = await saveParticipant(draft, { id: formState.id });
    closeDialog(elements.participantDialog);
    const updated = await refresh();

    if (updated) {
      showToast({
        tone: 'success',
        message: isEdit ? `Данные сохранены: ${saved.name}` : `Участник добавлен: ${saved.name}`,
      });
    }
  } catch (error) {
    if (error instanceof ValidationError) {
      applyErrors(error.errors);
      formState.touched = new Set(Object.keys(error.errors));
      focusFirstError(error.errors);
      elements.participantFormError.textContent = 'Проверьте поля с ошибками и сохраните снова.';
      elements.participantFormError.hidden = false;
    } else {
      elements.participantFormError.textContent = getActionErrorMessage(error);
      elements.participantFormError.hidden = false;
    }
  } finally {
    setFormBusy(false);
  }
}

function setFormBusy(busy) {
  formState.submitting = busy;
  elements.participantForm.setAttribute('aria-busy', String(busy));

  elements.participantForm.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.disabled = busy;
  });

  if (busy) {
    elements.participantSubmit.disabled = true;
  } else {
    syncFormValidation();
  }
}

/* ---------- Импорт CSV ---------- */

function handleImportCsvClick() {
  if (state.loading) {
    showToast({ tone: 'info', message: 'Дождитесь загрузки данных и повторите импорт.' });
    return;
  }

  if (state.error) {
    showToast({
      tone: 'error',
      message: 'Данные из IndexedDB недоступны. Перезагрузите страницу и повторите импорт.',
    });
    return;
  }

  elements.csvFileInput.click();
}

async function handleCsvFileSelected(event) {
  const file = event.target.files?.[0] ?? null;
  // Сбрасываем input, чтобы можно было выбрать тот же файл повторно.
  elements.csvFileInput.value = '';

  if (!file) {
    return;
  }

  await openCsvPreview(file);
}

async function openCsvPreview(file) {
  const requestId = importState.requestId + 1;
  importState.requestId = requestId;
  importState.fileName = file.name;
  importState.analysis = null;
  importState.busy = false;

  elements.importSubtitle.textContent = file.name;
  elements.importError.hidden = true;
  elements.importError.textContent = '';
  elements.importBody.replaceChildren(createImportLoading());
  elements.importSubmit.disabled = true;
  elements.importSubmit.textContent = 'Импортировать';
  elements.importDialog.setAttribute('aria-busy', 'true');

  if (!elements.importDialog.open) {
    openDialog(elements.importDialog);
  }

  elements.importCancel.focus();

  if (!/\.csv$/i.test(file.name)) {
    showImportFileError('Выберите файл с расширением .csv.');
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    showImportFileError('Файл больше 10 МБ. Разделите его на части и повторите импорт.');
    return;
  }

  try {
    const text = await file.text();
    const parsed = parseCsv(text);
    const analysis = analyzeCsv(parsed.records, state.participants);

    if (requestId !== importState.requestId) {
      return;
    }

    importState.analysis = analysis;
    renderImportPreview(file.name, analysis);
  } catch (error) {
    if (requestId !== importState.requestId) {
      return;
    }

    if (error instanceof CsvError) {
      showImportFileError(error.message);
    } else {
      showImportFileError('Не удалось прочитать файл. Убедитесь, что это CSV в кодировке UTF-8, и повторите попытку.');
    }
  }
}

function showImportFileError(message) {
  importState.analysis = null;
  elements.importDialog.setAttribute('aria-busy', 'false');
  elements.importError.textContent = message;
  elements.importError.hidden = false;
  elements.importSubtitle.textContent = importState.fileName
    ? `${importState.fileName} · файл не принят`
    : 'Файл не выбран';

  const wrap = el('div', 'import-empty');
  const icon = el('span', 'import-empty__icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon('icon-alert'));

  const text = el('p');
  text.textContent = 'База данных не изменилась. Исправьте файл или выберите другой.';

  const button = el('button', 'btn btn--secondary');
  button.type = 'button';
  button.append(createIcon('icon-upload'), document.createTextNode('Выбрать другой файл'));
  button.addEventListener('click', () => elements.csvFileInput.click());

  wrap.append(icon, text, button);
  elements.importBody.replaceChildren(wrap);
  elements.importSubmit.disabled = true;
  elements.importSubmit.textContent = 'Импортировать';
  elements.importCancel.focus();
}

function renderImportPreview(fileName, analysis) {
  const { stats, rows, duplicates, validRows } = analysis;

  elements.importDialog.setAttribute('aria-busy', 'false');
  elements.importError.hidden = true;
  elements.importSubtitle.textContent = `${fileName} · строк: ${stats.total}`;

  const fragment = document.createDocumentFragment();
  fragment.append(createImportStats(stats));
  fragment.append(createImportNote());

  if (duplicates.length > 0) {
    fragment.append(createImportDuplicateSection(duplicates));
  }

  const errorRows = rows.filter((row) => !row.valid);
  if (errorRows.length > 0) {
    fragment.append(createImportErrorSection(errorRows));
  }

  fragment.append(createImportValidSection(validRows));
  elements.importBody.replaceChildren(fragment);

  elements.importSubmit.disabled = stats.valid === 0;
  elements.importSubmit.textContent = getImportSubmitLabel(analysis);

  if (stats.valid > 0) {
    elements.importSubmit.focus();
  } else {
    elements.importCancel.focus();
  }
}

function createImportLoading() {
  const wrap = el('div', 'import-loading');
  const spinner = el('span', 'import-spinner');
  spinner.setAttribute('aria-hidden', 'true');

  const text = el('p');
  text.textContent = 'Читаем файл и проверяем строки…';

  wrap.append(spinner, text);
  return wrap;
}

function createImportStats(stats) {
  const grid = el('div', 'import-stats');

  [
    ['Всего строк', stats.total, 'total'],
    ['Корректных', stats.valid, 'valid'],
    ['Ошибочных', stats.invalid, 'invalid'],
    ['Дубликатов', stats.duplicates, 'duplicate'],
  ].forEach(([label, value, tone]) => {
    const card = el('div', `import-stat import-stat--${tone}`);
    const valueNode = el('p', 'import-stat__value');
    valueNode.textContent = String(value);
    const labelNode = el('p', 'import-stat__label');
    labelNode.textContent = label;
    card.append(valueNode, labelNode);
    grid.append(card);
  });

  return grid;
}

function createImportNote() {
  const note = el('p', 'import-note');
  note.append(
    createIcon('icon-info'),
    document.createTextNode('До подтверждения IndexedDB не изменяется. После импорта в базу попадут только корректные строки.'),
  );
  return note;
}

function createImportDuplicateSection(duplicates) {
  const section = el('section', 'import-section');
  const title = el('h3', 'import-section__title');
  title.append(createIcon('icon-alert'), document.createTextNode(`Дубликаты по email: ${duplicates.length}`));

  const list = el('ul', 'import-list');
  duplicates.forEach((row) => {
    const item = el('li', 'import-list__item');
    const line = el('span', 'import-line');
    line.textContent = `Строка ${row.line}`;

    const email = el('span', 'import-email');
    email.textContent = row.email || '—';

    const reason = el('span', 'import-reason');
    reason.textContent = row.errors.find((message) => {
      return message.includes('дубликат') || message.includes('уже есть');
    }) ?? 'дубликат email';

    item.append(line, email, reason);
    list.append(item);
  });

  section.append(title, list);
  return section;
}

function createImportErrorSection(errorRows) {
  const section = el('section', 'import-section');
  const title = el('h3', 'import-section__title');
  title.append(createIcon('icon-alert'), document.createTextNode(`Ошибки: ${errorRows.length}`));

  const list = el('ul', 'import-errors');
  errorRows.forEach((row) => {
    const item = el('li', 'import-error-item');

    const head = el('div', 'import-error-item__head');
    const line = el('span', 'import-line import-line--error');
    line.textContent = `Строка ${row.line}`;

    const who = el('span', 'import-error-item__who');
    const label = [row.name, row.email].filter(Boolean).join(' · ');
    who.textContent = label || 'Пустая или неполная строка';
    head.append(line, who);

    const reasons = el('ul', 'import-error-reasons');
    row.errors.forEach((message) => {
      const reason = document.createElement('li');
      reason.textContent = message;
      reasons.append(reason);
    });

    item.append(head, reasons);
    list.append(item);
  });

  section.append(title, list);
  return section;
}

function createImportValidSection(validRows) {
  const section = el('section', 'import-section');
  const title = el('h3', 'import-section__title');
  title.append(createIcon('icon-check-circle'), document.createTextNode(`Будут импортированы: ${validRows.length}`));
  section.append(title);

  if (validRows.length === 0) {
    const note = el('p', 'import-empty-note');
    note.textContent = 'Нет строк без ошибок. Исправьте файл и выберите его снова.';
    section.append(note);
    return section;
  }

  const wrap = el('div', 'import-table-wrap');
  const table = el('table', 'import-table');
  const caption = el('caption', 'visually-hidden');
  caption.textContent = 'Корректные строки, которые будут импортированы';

  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Строка', 'Участник', 'Билет', 'Статус', 'Регистрация', 'Приход'].forEach((label) => {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    headRow.append(cell);
  });
  head.append(headRow);

  const body = document.createElement('tbody');
  validRows.forEach((row) => {
    const tableRow = document.createElement('tr');

    const lineCell = document.createElement('td');
    lineCell.textContent = String(row.line);

    const personCell = document.createElement('td');
    const person = el('div', 'import-table__person');
    const name = el('span', 'import-table__name');
    name.textContent = row.name;
    const email = el('span', 'import-table__email');
    email.textContent = row.email;
    person.append(name, email);
    personCell.append(person);

    const ticketCell = document.createElement('td');
    ticketCell.append(createTicketBadge(row.ticket));

    const statusCell = document.createElement('td');
    statusCell.append(createStatusChip(row.status));

    const dateCell = document.createElement('td');
    dateCell.textContent = formatDate(row.registeredAt);

    const checkinCell = document.createElement('td');
    checkinCell.append(createCheckin(row));

    tableRow.append(lineCell, personCell, ticketCell, statusCell, dateCell, checkinCell);
    body.append(tableRow);
  });

  table.append(caption, head, body);
  wrap.append(table);
  section.append(wrap);
  return section;
}

async function handleImportSubmit(event) {
  event.preventDefault();

  const analysis = importState.analysis;
  if (importState.busy || !analysis || analysis.stats.valid === 0) {
    return;
  }

  setImportBusy(true);
  elements.importError.hidden = true;

  try {
    const result = await importParticipants(analysis.participants);
    closeDialog(elements.importDialog);
    resetImportState();
    const updated = await refresh();

    if (updated) {
      const parts = [`Импорт завершён: ${formatImportedCount(result.imported)}.`];
      if (result.skipped > 0) {
        parts.push(`Пропущено ${result.skipped} ${pluralizeRows(result.skipped)}: данные уже есть в базе или изменились.`);
      }

      showToast({
        tone: result.imported > 0 ? 'success' : 'info',
        message: parts.join(' '),
      });
    }
  } catch (error) {
    elements.importError.textContent = getActionErrorMessage(error);
    elements.importError.hidden = false;
    setImportBusy(false);
    elements.importCancel.focus();
  }
}

function setImportBusy(busy) {
  importState.busy = busy;
  elements.importDialog.setAttribute('aria-busy', String(busy));
  elements.importSubmit.disabled = busy || !importState.analysis || importState.analysis.stats.valid === 0;
  elements.importSubmit.textContent = busy ? 'Импортируем…' : getImportSubmitLabel(importState.analysis);
  elements.importCancel.disabled = busy;

  elements.importForm.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.disabled = busy;
  });
}

function resetImportState() {
  importState.fileName = '';
  importState.analysis = null;
  importState.busy = false;
  importState.requestId += 1;

  elements.csvFileInput.value = '';
  elements.importError.hidden = true;
  elements.importError.textContent = '';
  elements.importBody.replaceChildren();
  elements.importSubtitle.textContent = 'Файл не выбран';
  elements.importSubmit.disabled = true;
  elements.importSubmit.textContent = 'Импортировать';
  elements.importCancel.disabled = false;
  elements.importDialog.setAttribute('aria-busy', 'false');

  elements.importForm.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.disabled = false;
  });
}

function getImportSubmitLabel(analysis) {
  if (!analysis || analysis.stats.valid === 0) {
    return 'Импортировать';
  }

  return `Импортировать ${analysis.stats.valid} ${pluralizeRows(analysis.stats.valid)}`;
}

function pluralizeRows(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'строку';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'строки';
  }

  return 'строк';
}

function formatImportedCount(count) {
  if (count === 1) {
    return 'добавлена 1 строка';
  }

  return `добавлено ${count} ${pluralizeRows(count)}`;
}

/* ---------- Резервная копия ---------- */

async function handleExportJson() {
  if (exportState.busy) {
    return;
  }

  if (state.loading || state.error) {
    showToast({
      tone: 'info',
      message: 'Дождитесь загрузки данных из IndexedDB и повторите экспорт.',
    });
    return;
  }

  setExportBusy(true);

  try {
    const snapshot = await getSnapshot();
    const backup = createBackupDocument(snapshot);
    const json = JSON.stringify(backup, null, 2);
    const fileName = buildBackupFileName(backup.exportedAt);

    downloadJson(json, fileName);

    let logged = true;
    try {
      await recordBackupExport({
        participants: backup.participants.length,
        activity: backup.activity.length,
      });
    } catch (error) {
      logged = false;
      console.warn('EventFlow: не удалось записать экспорт в журнал действий.', error);
    }

    const updated = await refresh();
    const message = `Резервная копия сохранена: ${formatParticipantsCount(backup.participants.length)} и ` +
      `${formatActivityCount(backup.activity.length)}.` +
      (logged ? '' : ' Запись в журнал добавить не удалось.');

    if (updated) {
      showToast({ tone: 'success', message });
    } else {
      showToast({ tone: 'success', message: 'Резервная копия сохранена, но обновить экран не удалось.' });
    }
  } catch (error) {
    console.error('EventFlow: не удалось создать резервную копию.', error);
    showToast({
      tone: 'error',
      message: 'Не удалось создать резервную копию. Проверьте доступ к IndexedDB и повторите попытку.',
    });
  } finally {
    setExportBusy(false);
  }
}

function setExportBusy(busy) {
  exportState.busy = busy;
  elements.exportJsonLabel.textContent = busy ? 'Экспортируем…' : 'Экспорт JSON';
  syncHeaderActions();
}

function buildBackupFileName(exportedAt) {
  const date = new Date(exportedAt);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;
  const pad = (value) => String(value).padStart(2, '0');

  return [
    'eventflow-backup',
    safeDate.getFullYear(),
    pad(safeDate.getMonth() + 1),
    pad(safeDate.getDate()),
    `${pad(safeDate.getHours())}${pad(safeDate.getMinutes())}`,
  ].join('-') + '.json';
}

function downloadJson(text, fileName) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';

  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function handleRestoreClick() {
  if (state.loading) {
    showToast({ tone: 'info', message: 'Дождитесь загрузки данных и повторите восстановление.' });
    return;
  }

  if (state.error) {
    showToast({
      tone: 'error',
      message: 'Данные из IndexedDB недоступны. Перезагрузите страницу и повторите восстановление.',
    });
    return;
  }

  elements.jsonFileInput.click();
}

async function handleJsonFileSelected(event) {
  const file = event.target.files?.[0] ?? null;
  // Сбрасываем input, чтобы можно было выбрать тот же файл повторно.
  elements.jsonFileInput.value = '';

  if (!file) {
    return;
  }

  await openRestorePreview(file);
}

async function openRestorePreview(file) {
  const requestId = restoreState.requestId + 1;
  restoreState.requestId = requestId;
  restoreState.fileName = file.name;
  restoreState.backup = null;
  restoreState.stage = 'loading';
  restoreState.busy = false;
  restoreState.confirmCheckbox = null;

  elements.restoreSubtitle.textContent = file.name;
  elements.restoreError.hidden = true;
  elements.restoreError.textContent = '';
  elements.restoreBody.replaceChildren(createRestoreLoading());
  elements.restoreDialog.setAttribute('aria-busy', 'true');
  syncRestoreFooter();

  if (!elements.restoreDialog.open) {
    openDialog(elements.restoreDialog);
  }

  elements.restoreCancel.focus();

  if (!/\.json$/i.test(file.name)) {
    showRestoreError('Выберите файл с расширением .json.');
    return;
  }

  if (file.size > 10 * 1024 * 1024) {
    showRestoreError('Файл больше 10 МБ. Выберите резервную копию меньшего размера.');
    return;
  }

  try {
    const text = await file.text();
    let parsed;

    try {
      parsed = JSON.parse(text);
    } catch (error) {
      showRestoreError('Файл не является корректным JSON. Проверьте содержимое и выберите файл снова.');
      return;
    }

    const backup = validateBackupDocument(parsed);

    if (requestId !== restoreState.requestId) {
      return;
    }

    restoreState.backup = backup;
    renderRestorePreview();
  } catch (error) {
    if (requestId !== restoreState.requestId) {
      return;
    }

    if (error instanceof BackupError) {
      showRestoreError(error.message, error.details);
    } else {
      showRestoreError('Не удалось прочитать файл. Убедитесь, что это JSON в кодировке UTF-8, и повторите попытку.');
    }
  }
}

function showRestoreError(message, details = []) {
  restoreState.stage = 'error';
  restoreState.backup = null;
  restoreState.busy = false;
  restoreState.confirmCheckbox = null;

  elements.restoreDialog.setAttribute('aria-busy', 'false');
  elements.restoreError.textContent = message;
  elements.restoreError.hidden = false;
  elements.restoreSubtitle.textContent = restoreState.fileName
    ? `${restoreState.fileName} · файл не принят`
    : 'Файл не выбран';

  const wrap = el('div', 'import-empty restore-error');
  const icon = el('span', 'import-empty__icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon('icon-alert'));

  const text = el('p');
  text.textContent = 'Текущие данные не изменены. Исправьте файл или выберите другую резервную копию.';
  wrap.append(icon, text);

  if (details.length > 0) {
    const list = el('ul', 'restore-error-list');
    details.forEach((detail) => {
      const item = document.createElement('li');
      item.textContent = detail;
      list.append(item);
    });
    wrap.append(list);
  }

  const button = el('button', 'btn btn--secondary');
  button.type = 'button';
  button.append(createIcon('icon-restore'), document.createTextNode('Выбрать другой файл'));
  button.addEventListener('click', () => elements.jsonFileInput.click());
  wrap.append(button);

  elements.restoreBody.replaceChildren(wrap);
  syncRestoreFooter();
  elements.restoreCancel.focus();
}

function createRestoreLoading() {
  const wrap = el('div', 'import-loading');
  const spinner = el('span', 'import-spinner');
  spinner.setAttribute('aria-hidden', 'true');

  const text = el('p');
  text.textContent = 'Проверяем структуру, версию и записи резервной копии…';

  wrap.append(spinner, text);
  return wrap;
}

function renderRestorePreview() {
  const backup = restoreState.backup;
  if (!backup) {
    return;
  }

  restoreState.stage = 'preview';
  restoreState.busy = false;
  restoreState.confirmCheckbox = null;

  elements.restoreDialog.setAttribute('aria-busy', 'false');
  elements.restoreError.hidden = true;
  elements.restoreError.textContent = '';
  elements.restoreSubtitle.textContent = `${restoreState.fileName} · schemaVersion ${backup.schemaVersion}`;

  const active = backup.participants.filter((participant) => !participant.archivedAt);
  const archived = backup.participants.length - active.length;
  const confirmed = backup.participants.filter((participant) => participant.status === 'confirmed').length;
  const arrived = backup.participants.filter((participant) => participant.checkedIn === true).length;

  const fragment = document.createDocumentFragment();
  fragment.append(createRestoreFileCard(backup));

  const stats = el('div', 'backup-stats');
  [
    ['Участники', backup.participants.length, 'total'],
    ['Активные', active.length, 'active'],
    ['В архиве', archived, 'archived'],
    ['Действия', backup.activity.length, 'activity'],
  ].forEach(([label, value, tone]) => {
    stats.append(createBackupStat(label, value, tone));
  });
  fragment.append(stats);

  const note = el('p', 'import-note');
  note.append(
    createIcon('icon-check-circle'),
    document.createTextNode(
      `Файл проверен. Подтверждены: ${confirmed}, отмечены как пришедшие: ${arrived}. ` +
      'До подтверждения IndexedDB не изменяется.',
    ),
  );
  fragment.append(note);

  const warning = el('div', 'backup-warning');
  const warningText = el('div');
  const warningTitle = el('p', 'backup-warning__title');
  warningTitle.textContent = 'Текущие данные будут заменены';
  const warningBody = el('p');
  warningBody.textContent = `Сейчас в базе ${formatParticipantsCount(state.participants.length)} и ` +
    `${formatActivityCount(state.activity.length)}. После подтверждения они полностью заменятся данными из копии.`;
  warningText.append(warningTitle, warningBody);
  warning.append(createIcon('icon-alert'), warningText);
  fragment.append(warning);

  elements.restoreBody.replaceChildren(fragment);
  syncRestoreFooter();
  elements.restoreSubmit.focus();
}

function createRestoreFileCard(backup) {
  const card = el('div', 'backup-file');
  const icon = el('span', 'backup-file__icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon('icon-database'));

  const info = el('div', 'backup-file__info');
  const name = el('p', 'backup-file__name');
  name.textContent = restoreState.fileName || 'Резервная копия EventFlow';
  const meta = el('p', 'backup-file__meta');
  meta.textContent = `${formatDateTime(backup.exportedAt)} · событие «${backup.event.name}»`;
  info.append(name, meta);

  card.append(icon, info);
  return card;
}

function createBackupStat(label, value, tone) {
  const card = el('div', `backup-stat backup-stat--${tone}`);
  const valueNode = el('p', 'backup-stat__value');
  valueNode.textContent = String(value);
  const labelNode = el('p', 'backup-stat__label');
  labelNode.textContent = label;
  card.append(valueNode, labelNode);
  return card;
}

function renderRestoreConfirm() {
  const backup = restoreState.backup;
  if (!backup) {
    return;
  }

  restoreState.stage = 'confirm';
  restoreState.busy = false;

  elements.restoreDialog.setAttribute('aria-busy', 'false');
  elements.restoreError.hidden = true;
  elements.restoreError.textContent = '';
  elements.restoreSubtitle.textContent = `${restoreState.fileName} · подтверждение замены`;

  const fragment = document.createDocumentFragment();
  const warning = el('div', 'backup-warning backup-warning--danger');
  const warningText = el('div');
  const warningTitle = el('p', 'backup-warning__title');
  warningTitle.textContent = 'Заменить все текущие данные?';
  const warningBody = el('p');
  warningBody.textContent = 'Участники, настройки события и журнал действий будут заменены без возможности отмены.';
  warningText.append(warningTitle, warningBody);
  warning.append(createIcon('icon-alert'), warningText);
  fragment.append(warning);

  const compare = el('div', 'restore-compare');
  compare.append(createRestoreCompareCard(
    'Сейчас в базе',
    state.participants.length,
    state.activity.length,
    'current',
  ));
  compare.append(createRestoreCompareCard(
    'Будет восстановлено',
    backup.participants.length,
    backup.activity.length,
    'backup',
  ));
  fragment.append(compare);

  const label = el('label', 'checkbox restore-confirm');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.id = 'restore-confirm-checkbox';
  checkbox.addEventListener('change', syncRestoreFooter);
  const text = document.createElement('span');
  text.textContent = 'Я понимаю, что текущие участники, настройки и журнал будут заменены.';
  label.append(checkbox, text);
  fragment.append(label);

  restoreState.confirmCheckbox = checkbox;
  elements.restoreBody.replaceChildren(fragment);
  syncRestoreFooter();
  checkbox.focus();
}

function createRestoreCompareCard(title, participants, activity, tone) {
  const card = el('div', `restore-compare__card restore-compare__card--${tone}`);
  const heading = el('p', 'restore-compare__title');
  heading.textContent = title;
  const participantsValue = el('p', 'restore-compare__value');
  participantsValue.textContent = formatParticipantsCount(participants);
  const activityValue = el('p', 'restore-compare__meta');
  activityValue.textContent = formatActivityCount(activity);
  card.append(heading, participantsValue, activityValue);
  return card;
}

function handleRestoreBack() {
  if (restoreState.stage === 'confirm' && restoreState.backup) {
    renderRestorePreview();
  }
}

async function handleRestoreSubmit(event) {
  event.preventDefault();

  if (restoreState.busy) {
    return;
  }

  if (restoreState.stage === 'preview') {
    renderRestoreConfirm();
    return;
  }

  if (restoreState.stage !== 'confirm' || !restoreState.backup) {
    return;
  }

  if (!restoreState.confirmCheckbox?.checked) {
    return;
  }

  const backupName = restoreState.fileName;
  setRestoreBusy(true);
  elements.restoreError.hidden = true;

  try {
    const result = await restoreBackup(restoreState.backup);
    closeDialog(elements.restoreDialog);
    resetRestoreState();
    const updated = await refresh();

    if (updated) {
      showToast({
        tone: 'success',
        message: `Данные восстановлены из «${backupName}»: ` +
          `${formatParticipantsCount(result.participants)} и ${formatActivityCount(result.activity)}.`,
      });
    }
  } catch (error) {
    console.error('EventFlow: не удалось восстановить резервную копию.', error);
    elements.restoreError.textContent = getActionErrorMessage(error);
    elements.restoreError.hidden = false;
    setRestoreBusy(false);
    elements.restoreCancel.focus();
  }
}

function setRestoreBusy(busy) {
  restoreState.busy = busy;
  elements.restoreDialog.setAttribute('aria-busy', String(busy));
  elements.restoreForm.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.disabled = busy;
  });
  syncRestoreFooter();
  syncHeaderActions();
}

function syncRestoreFooter() {
  const { stage, busy, confirmCheckbox } = restoreState;

  elements.restoreCancel.disabled = busy;
  elements.restoreBack.hidden = stage !== 'confirm';
  elements.restoreBack.disabled = busy;

  if (stage === 'preview') {
    elements.restoreSubmit.hidden = false;
    elements.restoreSubmit.className = 'btn btn--primary';
    elements.restoreSubmit.textContent = 'Продолжить к подтверждению';
    elements.restoreSubmit.disabled = busy;
    return;
  }

  if (stage === 'confirm') {
    elements.restoreSubmit.hidden = false;
    elements.restoreSubmit.className = 'btn btn--danger-solid';
    elements.restoreSubmit.textContent = busy ? 'Восстанавливаем…' : 'Заменить данные';
    elements.restoreSubmit.disabled = busy || !(confirmCheckbox?.checked);
    return;
  }

  elements.restoreSubmit.hidden = stage === 'error' || stage === 'idle';
  elements.restoreSubmit.className = 'btn btn--primary';
  elements.restoreSubmit.textContent = stage === 'loading' ? 'Проверяем…' : 'Продолжить';
  elements.restoreSubmit.disabled = true;
}

function resetRestoreState() {
  restoreState.requestId += 1;
  restoreState.fileName = '';
  restoreState.backup = null;
  restoreState.stage = 'idle';
  restoreState.busy = false;
  restoreState.confirmCheckbox = null;

  elements.jsonFileInput.value = '';
  elements.restoreError.hidden = true;
  elements.restoreError.textContent = '';
  elements.restoreBody.replaceChildren();
  elements.restoreSubtitle.textContent = 'Файл не выбран';
  elements.restoreDialog.setAttribute('aria-busy', 'false');

  elements.restoreForm.querySelectorAll('[data-close-dialog]').forEach((button) => {
    button.disabled = false;
  });

  syncRestoreFooter();
  syncHeaderActions();
}

function formatParticipantsCount(count) {
  return `${count} ${pluralize(count, ['участник', 'участника', 'участников'])}`;
}

function formatActivityCount(count) {
  return `${count} ${pluralize(count, ['действие', 'действия', 'действий'])}`;
}

function pluralize(count, forms) {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return forms[0];
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return forms[1];
  }

  return forms[2];
}

/* ---------- Диалоги ---------- */

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', '');
  }
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function' && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute('open');
  }
}

function closeAllDialogs() {
  document.querySelectorAll('dialog[open]').forEach((dialog) => closeDialog(dialog));
}

/* ---------- Уведомления ---------- */

function showToast({
  tone = 'info',
  message,
  actionLabel = '',
  onAction = null,
  duration = DEFAULT_TOAST_DURATION,
}) {
  while (elements.toastRegion.children.length >= 3) {
    elements.toastRegion.firstElementChild?.remove();
  }

  const toast = el('div', `toast toast--${tone}`);
  toast.setAttribute('role', tone === 'error' ? 'alert' : 'status');

  const icon = el('span', 'toast__icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(createIcon(
    tone === 'error' ? 'icon-alert' : tone === 'success' ? 'icon-check-circle' : 'icon-info',
  ));

  const text = el('p', 'toast__message');
  text.textContent = message;

  const close = el('button', 'toast__close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть уведомление');
  close.append(createIcon('icon-x'));

  let timer = null;
  const dismiss = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = null;
    }
    toast.classList.add('toast--leaving');
    window.setTimeout(() => toast.remove(), 180);
  };

  toast.append(icon, text);

  if (actionLabel && typeof onAction === 'function') {
    const action = el('button', 'toast__action');
    action.type = 'button';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      action.disabled = true;
      dismiss();
      Promise.resolve()
        .then(onAction)
        .catch((error) => {
          showToast({ tone: 'error', message: getActionErrorMessage(error) });
        });
    });
    toast.append(action);
  }

  close.addEventListener('click', dismiss);
  toast.append(close);
  elements.toastRegion.append(toast);

  if (duration > 0) {
    timer = window.setTimeout(dismiss, duration);
  }

  return toast;
}

function getActionErrorMessage(error) {
  if (!error) {
    return 'Не удалось выполнить действие. Повторите попытку.';
  }

  switch (error.code) {
    case 'not_found':
      return error.message || 'Участник не найден. Возможно, запись уже изменили в другой вкладке.';
    case 'checkin_not_allowed':
      return 'Отметить приход можно только подтверждённому участнику.';
    case 'archived':
      return 'Участник находится в архиве. Сначала восстановите запись.';
    case 'validation':
      return 'Проверьте заполнение формы: часть данных не принята базой.';
    case 'backup':
    case 'backup_structure':
    case 'backup_version':
      return error.message || 'Файл резервной копии не прошёл проверку.';
    case 'restore':
      return 'Не удалось восстановить данные. Текущая база не изменена. Повторите попытку.';
    case 'blocked':
      return 'База данных открыта в другой вкладке EventFlow. Закройте другие вкладки и повторите попытку.';
    default:
      return 'Не удалось сохранить изменения в IndexedDB. Повторите попытку.';
  }
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Дата не указана' : dateFormatter.format(date);
}

function createIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${name}`);
  svg.append(use);
  return svg;
}

function el(tagName, className = '') {
  const node = document.createElement(tagName);
  if (className) {
    node.className = className;
  }
  return node;
}

function setMetric(element, value) {
  element.textContent = String(value);
}

function normalizeEvent(event) {
  const source = event && typeof event === 'object' ? event : {};
  const name = safeText(source.name, DEFAULT_EVENT.name);
  const venue = safeText(source.venue, DEFAULT_EVENT.venue);
  const capacityValue = Number(source.capacity);
  const capacity = Number.isFinite(capacityValue) && capacityValue >= 0
    ? capacityValue
    : DEFAULT_EVENT.capacity;

  return { name, venue, capacity };
}

function isActive(participant) {
  return !participant.archivedAt;
}

function toTime(value) {
  const time = Date.parse(value);
  return Number.isNaN(time) ? 0 : time;
}

function getInitials(name) {
  const words = safeText(name, '')
    .split(/\s+/)
    .filter(Boolean);

  if (words.length === 0) {
    return '?';
  }

  return words
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toLocaleUpperCase('ru-RU');
}

function safeText(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Время не указано';
  }
  return dateTimeFormatter.format(date);
}

function formatCapacity(value) {
  const capacity = Number(value);
  if (!Number.isFinite(capacity) || capacity < 0) {
    return 'Вместимость не указана';
  }

  const mod10 = capacity % 10;
  const mod100 = capacity % 100;
  let word = 'мест';

  if (mod10 === 1 && mod100 !== 11) {
    word = 'место';
  } else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    word = 'места';
  }

  return `${capacity} ${word}`;
}

function getErrorMessage(error) {
  if (!error) {
    return 'Не удалось открыть локальную базу данных. Проверьте настройки браузера и повторите попытку.';
  }

  if (error.code === 'blocked') {
    return 'База данных открыта в другой вкладке EventFlow. Закройте другие вкладки и повторите попытку.';
  }

  if (error.code === 'unsupported') {
    return 'Браузер не поддерживает IndexedDB. Откройте EventFlow в современном браузере.';
  }

  if (error.code === 'settings') {
    return 'Не удалось подготовить настройки события в IndexedDB. Проверьте, что браузер разрешает локальное хранилище.';
  }

  return 'Не удалось открыть локальную базу данных. Проверьте, что браузер разрешает IndexedDB, и повторите попытку.';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
