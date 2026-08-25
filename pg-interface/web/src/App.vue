<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
// Иконки библиотеки, а не свои: у нарисованных руками разная плотность, и рядом они выглядели
// разного размера. У библиотечных одна метрика и один размер, заданный `el-icon`.
import { Delete, Edit, Plus } from '@element-plus/icons-vue';
// The library's own wording, so the pager and the dialogs speak the language the rest of this screen does.
import russian from 'element-plus/es/locale/lang/ru.mjs';

import {
  addColumn,
  ApiError,
  COLUMN_TYPES,
  deleteRow,
  dropColumn,
  listDatabases,
  listTables,
  readRows,
  renameColumn,
  updateRow,
  type Column,
  type Filter,
  type RowsPage,
  type TableInfo,
} from './api';
import FilterPanel from './components/FilterPanel.vue';
import RowDialog from './components/RowDialog.vue';
import ValuePopover from './components/ValuePopover.vue';
import { CELL_LIMIT, cellText, isFilterReady, rowCountLabel, shortType } from './labels';
import { emptyView, PAGE_SIZES, readHash, writeHash, type View } from './view';

const databases = ref<string[]>([]);
const tables = ref<TableInfo[]>([]);
const page = ref<RowsPage | null>(null);
const view = ref<View>(emptyView());

const loadingTables = ref(false);
const loadingRows = ref(false);
const saving = ref(false);
const editing = ref<Record<string, unknown> | null>(null);
const filtersOpen = ref(false);

/** The column being added, while its dialog is open. Null the rest of the time. */
const adding = ref<{ column: string; type: string; required: boolean; default: string } | null>(null);
const reshaping = ref(false);

/**
 * What a required column of each type is filled with, as the server would fill it.
 *
 * Kept here as well so the field shows the value before it is sent — a person deciding whether a column
 * should be required needs to see what the existing rows will get. `uuid` has none: an identifier has no
 * neutral value, and the server refuses a required one.
 */
const TYPE_DEFAULTS: Record<string, string> = {
  text: '',
  integer: '0',
  bigint: '0',
  numeric: '0',
  boolean: 'false',
  timestamptz: 'now',
  date: 'now',
  jsonb: '{}',
};

/** A new column, ready for the dialog. */
function newColumn(): { column: string; type: string; required: boolean; default: string } {
  return { column: '', type: 'text', required: false, default: '' };
}

/**
 * The default follows the type, until somebody types their own.
 *
 * Only filled in for a required column, and only when the field still holds what this function last put
 * there: a value a person typed is theirs, and changing the type must not quietly discard it.
 */
function retype(): void {
  const request = adding.value;
  if (!request) return;

  const wasSuggested = Object.values(TYPE_DEFAULTS).includes(request.default) || request.default === '';
  if (!wasSuggested) return;

  request.default = request.required ? (TYPE_DEFAULTS[request.type] ?? '') : '';
}

/**
 * The cell the pointer is on, shown in full beside it. Null when nothing is shown.
 *
 * The element is kept along with the value: the popover points at the cell, so it has to know which
 * cell — one popover serves the whole table rather than one per cell.
 */
const peeking = ref<{ column: Column; value: unknown; anchor: HTMLElement } | null>(null);

/**
 * How long the pointer has to rest on a cell. Without a wait the popover flashes over every cell a
 * pointer crosses on its way somewhere else, which is noise rather than information.
 */
const PEEK_DELAY_MS = 250;
let peekTimer: ReturnType<typeof setTimeout> | undefined;

/** A cell with nothing in it has nothing to show. */
function peek(column: Column, row: Record<string, unknown>, event: MouseEvent | FocusEvent): void {
  const value = row[column.name];
  const anchor = event.currentTarget;
  if (value === null || value === undefined || value === '') return;
  if (!(anchor instanceof HTMLElement)) return;

  clearTimeout(peekTimer);
  peekTimer = setTimeout(() => (peeking.value = { column, value, anchor }), PEEK_DELAY_MS);
}

/** The pointer left, or the cell lost focus: nothing to show, and nothing pending either. */
function unpeek(): void {
  clearTimeout(peekTimer);
  peeking.value = null;
}

/**
 * Clicking a cell copies its whole value.
 *
 * The value as the database holds it, not as the popover shows it: a json document is copied on one line,
 * the way it is stored, because what is copied is usually going somewhere that wants the value rather
 * than its formatting.
 *
 * Two ways of copying, because this screen runs inside a frame: the clipboard API is not always allowed
 * there, and when it is refused the old `execCommand` on a hidden textarea still works. Without the
 * second one, clicking a cell in the panel did nothing at all.
 */
async function copyCell(column: Column, row: Record<string, unknown>): Promise<void> {
  const value = row[column.name];
  if (value === null || value === undefined) return;

  const text = cellText(value);

  try {
    await navigator.clipboard.writeText(text);
    ElMessage({ type: 'success', message: `${column.name} скопировано`, duration: 1500 });
    return;
  } catch {
    if (copyTheOldWay(text)) {
      ElMessage({ type: 'success', message: `${column.name} скопировано`, duration: 1500 });
      return;
    }
  }

  ElMessage({ type: 'info', message: 'Скопировать не удалось — выделите значение в подсказке' });
}

/** `execCommand('copy')`, which needs a real selection in a real element. Removed straight after. */
function copyTheOldWay(text: string): boolean {
  const carrier = document.createElement('textarea');
  carrier.value = text;
  carrier.setAttribute('readonly', '');
  carrier.style.position = 'fixed';
  carrier.style.opacity = '0';
  document.body.appendChild(carrier);

  try {
    carrier.select();
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    carrier.remove();
  }
}

onBeforeUnmount(() => clearTimeout(peekTimer));

const table = computed(() =>
  tables.value.find((entry) => entry.schema === view.value.schema && entry.name === view.value.table),
);

/** Columns as shown: the view's list if it has one, everything otherwise. */
const shown = computed<Column[]>(() => {
  const all = page.value?.columns ?? table.value?.columns ?? [];
  if (view.value.columns.length === 0) return all;
  return all.filter((column) => view.value.columns.includes(column.name));
});

const sortOf = (column: string) => view.value.order.find((entry) => entry.column === column);

/** Filters that are actually narrowing the page — a half-filled one is not counted, because it is not asked. */
const asked = computed(() => view.value.filters.filter(isFilterReady).length);

function report(error: unknown): void {
  const message = error instanceof ApiError ? error.message : String(error);
  ElMessage({ type: 'error', message, duration: 6000, showClose: true });
}

async function openDatabase(name: string): Promise<void> {
  view.value = { ...emptyView(), database: name };
  page.value = null;
  tables.value = [];
  loadingTables.value = true;

  try {
    tables.value = (await listTables(name)).tables;
  } catch (error) {
    report(error);
  } finally {
    loadingTables.value = false;
  }
}

function openTable(entry: TableInfo): void {
  view.value = {
    ...emptyView(),
    database: view.value.database,
    schema: entry.schema,
    table: entry.name,
    size: view.value.size,
    // A table opens in the order its rows arrived, when it has a column that records that. Set as a
    // real sort rather than left to the server, so the arrow in the header says what is going on.
    order: entry.naturalOrder ? [{ column: entry.naturalOrder, direction: 'asc' }] : [],
  };
  void load();
}

async function load(): Promise<void> {
  if (!view.value.table) return;

  loadingRows.value = true;
  writeHash(view.value);

  try {
    page.value = await readRows(view.value.database, {
      schema: view.value.schema,
      table: view.value.table,
      filters: view.value.filters.filter(isFilterReady),
      combine: view.value.combine,
      order: view.value.order,
      limit: view.value.size,
      offset: (view.value.page - 1) * view.value.size,
    });
  } catch (error) {
    report(error);
  } finally {
    loadingRows.value = false;
  }
}

/** Sorting cycles: ascending, descending, off — the third click undoes the sort. */
function sort(column: string): void {
  const current = sortOf(column);
  const order =
    current === undefined
      ? [{ column, direction: 'asc' as const }]
      : current.direction === 'asc'
        ? [{ column, direction: 'desc' as const }]
        : [];

  view.value = { ...view.value, order, page: 1 };
  void load();
}

function hide(column: string): void {
  const all = (page.value?.columns ?? []).map((entry) => entry.name);
  const visible = view.value.columns.length === 0 ? all : view.value.columns;

  const columns = visible.filter((name) => name !== column);
  if (columns.length === 0) return;

  view.value = { ...view.value, columns };
  writeHash(view.value);
}

function showAll(): void {
  view.value = { ...view.value, columns: [] };
  writeHash(view.value);
}

function filterBy(column: string): void {
  const conditions = page.value?.columns.find((entry) => entry.name === column)?.conditions ?? [];
  const filters: Filter[] = [
    ...view.value.filters,
    { column, condition: conditions[0] ?? 'is', value: '' },
  ];

  view.value = { ...view.value, filters };
  filtersOpen.value = true;
}

function applyFilters(filters: Filter[], combine: 'and' | 'or'): void {
  view.value = { ...view.value, filters, combine, page: 1 };
  void load();
}

/** The key of a row, taken from the key the server named — never guessed from a column called id. */
function keyOf(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries((page.value?.primaryKey ?? []).map((column) => [column, row[column]]));
}

const changeable = computed(() => (page.value?.primaryKey.length ?? 0) > 0);

async function save(values: Record<string, unknown>): Promise<void> {
  const row = editing.value;
  if (!row) return;

  saving.value = true;
  try {
    await updateRow(view.value.database, {
      schema: view.value.schema,
      table: view.value.table,
      key: keyOf(row),
      values,
    });
    editing.value = null;
    ElMessage({ type: 'success', message: 'Строка сохранена' });
    await load();
  } catch (error) {
    report(error);
  } finally {
    saving.value = false;
  }
}

async function remove(row: Record<string, unknown>): Promise<void> {
  try {
    await ElMessageBox.confirm('Удалить строку? Это нельзя отменить.', 'Удаление строки', {
      confirmButtonText: 'Удалить',
      cancelButtonText: 'Отмена',
      type: 'warning',
    });
  } catch {
    return;
  }

  try {
    await deleteRow(view.value.database, {
      schema: view.value.schema,
      table: view.value.table,
      key: keyOf(row),
    });
    ElMessage({ type: 'success', message: 'Строка удалена' });
    await load();
  } catch (error) {
    report(error);
  }
}

/**
 * Changing the shape of a table.
 *
 * Adding is offered on every table the server calls reshapable; renaming and dropping only on a column
 * this interface added, which the server marks with `own`. A name is checked here as well as there —
 * not as a guard, but so a person sees "letters, digits, underscore" before a request is sent.
 */
const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

async function submitColumn(): Promise<void> {
  const request = adding.value;
  if (!request) return;

  reshaping.value = true;
  try {
    await addColumn(view.value.database, {
      schema: view.value.schema,
      table: view.value.table,
      column: request.column,
      type: request.type,
      required: request.required,
      // An empty field means "no default"; for a required column the server fills in the type's own.
      ...(request.default === '' ? {} : { default: request.default }),
    });

    adding.value = null;
    ElMessage({ type: 'success', message: 'Колонка добавлена' });
    await reshaped();
  } catch (error) {
    report(error);
  } finally {
    reshaping.value = false;
  }
}

async function startRename(column: string): Promise<void> {
  let to: string;
  try {
    const asked = await ElMessageBox.prompt('Новое имя колонки', `Переименовать ${column}`, {
      confirmButtonText: 'Переименовать',
      cancelButtonText: 'Отмена',
      inputValue: column,
      inputPattern: NAME_PATTERN,
      inputErrorMessage: 'Латиница, цифры и подчёркивание; начинается с буквы',
    });
    to = asked.value;
  } catch {
    return;
  }

  try {
    await renameColumn(view.value.database, {
      schema: view.value.schema,
      table: view.value.table,
      column,
      to,
    });
    ElMessage({ type: 'success', message: 'Колонка переименована' });
    await reshaped();
  } catch (error) {
    report(error);
  }
}

async function removeColumn(column: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `Удалить колонку ${column} вместе со всеми её значениями? Это нельзя отменить.`,
      'Удаление колонки',
      { confirmButtonText: 'Удалить', cancelButtonText: 'Отмена', type: 'warning' },
    );
  } catch {
    return;
  }

  try {
    await dropColumn(view.value.database, {
      schema: view.value.schema,
      table: view.value.table,
      column,
    });
    ElMessage({ type: 'success', message: 'Колонка удалена' });
    await reshaped();
  } catch (error) {
    report(error);
  }
}

/**
 * After a change of shape both halves of the screen are stale: the table list carries the columns and
 * their `own` flags, and the open page carries the rows. A hidden or sorted column that no longer
 * exists is dropped from the view, or the page would ask for a column the table does not have.
 */
async function reshaped(): Promise<void> {
  tables.value = (await listTables(view.value.database)).tables;

  const alive = new Set(table.value?.columns.map((column) => column.name) ?? []);
  view.value = {
    ...view.value,
    columns: view.value.columns.filter((name) => alive.has(name)),
    order: view.value.order.filter((entry) => alive.has(entry.column)),
    filters: view.value.filters.filter((filter) => alive.has(filter.column)),
  };

  await load();
}

function turnPage(next: number): void {
  view.value = { ...view.value, page: next };
  void load();
}

function resize(size: number): void {
  view.value = { ...view.value, size, page: 1 };
  void load();
}

watch(
  () => view.value.database,
  (database) => {
    if (database && tables.value.length === 0 && !loadingTables.value) void openDatabase(database);
  },
);

onMounted(async () => {
  try {
    databases.value = (await listDatabases()).databases.map((entry) => entry.name);
  } catch (error) {
    report(error);
    return;
  }

  // A link somebody sent opens what it was pointing at, which is the whole reason the view is in the URL.
  const fromHash = readHash(window.location.hash);
  const first = databases.value[0];

  if (fromHash && databases.value.includes(fromHash.database)) {
    view.value = fromHash;
    loadingTables.value = true;
    try {
      tables.value = (await listTables(fromHash.database)).tables;
    } catch (error) {
      report(error);
    } finally {
      loadingTables.value = false;
    }
    if (fromHash.table) await load();
  } else if (first) {
    await openDatabase(first);
  }
});
</script>

<template>
  <el-config-provider :locale="russian">
    <el-container class="shell">
    <el-aside class="shell-aside" width="18rem">
      <el-select
        :model-value="view.database"
        placeholder="База"
        class="shell-database"
        @update:model-value="openDatabase($event as string)"
      >
        <el-option v-for="name in databases" :key="name" :value="name" :label="name" />
      </el-select>

      <div v-loading="loadingTables" class="shell-tables">
        <button
          v-for="entry in tables"
          :key="`${entry.schema}.${entry.name}`"
          class="shell-table"
          :class="{ 'shell-table_active': entry.schema === view.schema && entry.name === view.table }"
          type="button"
          @click="openTable(entry)"
        >
          <span class="shell-table-name">{{ entry.name }}</span>
          <span class="shell-table-rows">{{ rowCountLabel(entry.rows) }}</span>
        </button>

        <p v-if="!loadingTables && tables.length === 0" class="shell-empty">Таблиц нет</p>
      </div>
    </el-aside>

    <el-main class="shell-main">
      <template v-if="view.table">
        <header class="head">
          <h1 class="head-title">{{ view.schema }}.{{ view.table }}</h1>

          <el-popover v-model:visible="filtersOpen" trigger="click" placement="bottom-start" width="auto">
            <template #reference>
              <el-button size="small" class="filters-button">
                Фильтры<span v-if="asked > 0"> · {{ asked }}</span>
              </el-button>
            </template>
            <FilterPanel
              :columns="page?.columns ?? []"
              :filters="view.filters"
              :combine="view.combine"
              @update="applyFilters"
            />
          </el-popover>

          <el-button v-if="view.columns.length > 0" size="small" text @click="showAll">
            Показать все колонки
          </el-button>

          <span v-if="!changeable" class="head-note">
            У таблицы нет первичного ключа — строки можно читать, но не менять
          </span>
        </header>

        <el-table
          v-loading="loadingRows"
          :data="page?.rows ?? []"
          class="rows"
          border
          height="100%"
        >
          <el-table-column
            v-for="column in shown"
            :key="column.name"
            :prop="column.name"
            :min-width="180"
            resizable
          >
            <template #header>
              <el-dropdown trigger="click">
                <span class="column-head">
                  {{ column.name }}
                  <span v-if="sortOf(column.name)" class="column-sort">
                    {{ sortOf(column.name)?.direction === 'asc' ? '↑' : '↓' }}
                  </span>
                  <span class="column-type" :title="column.type">{{ shortType(column.type) }}</span>
                </span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="sort(column.name)">
                      Сортировать{{ sortOf(column.name)?.direction === 'asc' ? ' по убыванию' : '' }}
                    </el-dropdown-item>
                    <el-dropdown-item @click="filterBy(column.name)">Фильтровать</el-dropdown-item>
                    <el-dropdown-item divided @click="hide(column.name)">Скрыть колонку</el-dropdown-item>
                    <!--
                      Переименовать и удалить можно только колонку, которую добавил сам интерфейс:
                      остальные принадлежат миграциям модуля, и его код читает их по имени. Сервер
                      отказывает в любом случае, а меню просто не предлагает того, что будет отказано.
                    -->
                    <el-dropdown-item v-if="column.own" divided @click="startRename(column.name)">
                      Переименовать колонку
                    </el-dropdown-item>
                    <el-dropdown-item v-if="column.own" @click="removeColumn(column.name)">
                      Удалить колонку
                    </el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>

            <template #default="{ row }">
              <span v-if="row[column.name] === null" class="value-cell value-cell_null">null</span>
              <!--
                Наведение показывает значение целиком, уход — убирает, нажатие копирует. Кнопка, а не
                просто текст, чтобы то же самое работало с клавиатуры: фокус показывает значение,
                Enter копирует. Своего `title` нет намеренно — его место занял поповер.
              -->
              <button
                v-else
                type="button"
                class="value-cell"
                title="Нажмите, чтобы скопировать"
                @mouseenter="peek(column, row, $event)"
                @mouseleave="unpeek"
                @focus="peek(column, row, $event)"
                @blur="unpeek"
                @click="copyCell(column, row)"
              >
                {{ cellText(row[column.name]).slice(0, CELL_LIMIT) }}
              </button>
            </template>
          </el-table-column>

          <!--
            Новая колонка — плюсиком в самой шапке, там, где колонки и кончаются: кнопка над таблицей
            была дальше от того, к чему относится. Колонка встанет последней и в базе — PostgreSQL
            добавляет только в конец, вставить в середину он не умеет.
          -->
          <el-table-column
            v-if="table?.reshapable !== false"
            label=""
            width="80"
            align="center"
            header-align="center"
            label-class-name="add-column-head"
          >
            <template #header>
              <el-button
                size="small"
                text
                class="add-column-button"
                title="Добавить колонку"
                @click="adding = newColumn()"
              >
                <el-icon class="icon"><Plus /></el-icon>
              </el-button>
            </template>
          </el-table-column>

          <!--
            Действия строки: открыть и удалить, обе кнопкой. Удаление раньше лежало под троеточием —
            но пряталось там в одиночестве, то есть меню было лишним шагом к единственному пункту.
            От промаха защищает не меню, а подтверждение: удаление спрашивает, прежде чем удалить.
          -->
          <el-table-column v-if="changeable" label="" width="84" fixed="right" align="center">
            <template #default="{ row }">
              <div class="actions">
                <el-button size="small" text title="Открыть строку" @click="editing = row">
                  <el-icon class="icon"><Edit /></el-icon>
                </el-button>

                <el-button
                  size="small"
                  text
                  class="actions-delete"
                  title="Удалить строку"
                  @click="remove(row)"
                >
                  <el-icon class="icon"><Delete /></el-icon>
                </el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>

        <footer class="foot">
          <el-pagination
            layout="total, sizes, prev, pager, next"
            :total="page?.total ?? 0"
            :page-size="view.size"
            :page-sizes="PAGE_SIZES"
            :current-page="view.page"
            @current-change="turnPage"
            @size-change="resize"
          />
        </footer>
      </template>

      <p v-else class="shell-empty">Выберите таблицу слева</p>
    </el-main>
    </el-container>
  </el-config-provider>

  <ValuePopover
    :column="peeking?.column ?? null"
    :value="peeking?.value"
    :anchor="peeking?.anchor ?? null"
  />

  <RowDialog
    :open="editing !== null"
    :schema="view.schema"
    :table="view.table"
    :columns="page?.columns ?? []"
    :primary-key="page?.primaryKey ?? []"
    :row="editing"
    :saving="saving"
    @close="editing = null"
    @save="save"
  />

  <el-dialog
    :model-value="adding !== null"
    title="Новая колонка"
    width="440px"
    class="add-column-dialog"
    @update:model-value="adding = null"
  >
    <template v-if="adding">
      <el-form label-position="top">
        <el-form-item label="Имя">
          <el-input v-model="adding.column" class="add-column-name" placeholder="например notes" />
        </el-form-item>
        <el-form-item label="Тип">
          <el-select v-model="adding.type" class="add-column-type" @change="retype">
            <el-option v-for="type in COLUMN_TYPES" :key="type" :value="type" :label="type" />
          </el-select>
        </el-form-item>

        <!--
          Подпись и переключатель в одну строку: у остальных полей подпись стоит над полем, потому
          что поле широкое, а переключатель узкий — над ним подпись оставляет пустую половину строки.
        -->
        <el-form-item>
          <label class="add-column-switch">
            <span>Обязательная</span>
            <el-switch v-model="adding.required" class="add-column-required" @change="retype" />
          </label>
        </el-form-item>

        <!--
          Значение по умолчанию: обязательной колонке оно нужно, необязательной — по желанию. Поле
          заполняется значением этого типа, и его можно поменять: сервер разбирает введённое по типу,
          иначе отказывает.
        -->
        <el-form-item :label="adding.required ? 'Значение по умолчанию' : 'Значение по умолчанию, если нужно'">
          <!--
            У обязательного текста значение по умолчанию — пустая строка, поэтому пустое поле здесь
            и есть значение. Подсказка говорит это словами: иначе пустое поле рядом со словом
            «обязательно» читается как «заполни, иначе не дам».
          -->
          <el-input
            v-model="adding.default"
            class="add-column-default"
            :placeholder="adding.required ? 'пустая строка' : 'нет'"
          />
        </el-form-item>
      </el-form>

      <p class="add-column-note">
        <template v-if="adding.required">
          Колонка будет обязательной, поэтому значение по умолчанию останется у неё навсегда: код модуля
          не знает про новую колонку и вставляет строки без неё.
          <template v-if="(table?.rows.count ?? 0) > 0">
            Существующие строки ({{ rowCountLabel(table!.rows) }}) получат это значение.
          </template>
        </template>
        <template v-else>
          Колонка будет необязательной — может быть пустой.
        </template>
      </p>
    </template>

    <template #footer>
      <el-button @click="adding = null">Отмена</el-button>
      <el-button
        type="primary"
        class="add-column-submit"
        :loading="reshaping"
        :disabled="!adding?.column"
        @click="submitColumn"
      >
        Добавить
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.shell {
  height: 100vh;
}

.shell-aside {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border-right: 1px solid var(--el-border-color);
  overflow: hidden;
}

.shell-database {
  width: 100%;
}

.shell-tables {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: auto;
}

.shell-table {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--el-text-color-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.shell-table:hover {
  background: var(--el-fill-color-light);
}

.shell-table_active {
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.shell-table-rows {
  color: var(--el-text-color-placeholder);
  font-variant-numeric: tabular-nums;
}

.shell-main {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  overflow: hidden;
}

.shell-empty {
  color: var(--el-text-color-placeholder);
}

.head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.head-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 600;
}

.head-note {
  color: var(--el-text-color-secondary);
  font-size: 0.85rem;
}

.rows {
  flex: 1;
  min-height: 0;
}

/*
 * The plus fills its header cell, so the whole cell is the button.
 *
 * A 15-pixel icon is a 15-pixel target in an 80-pixel column, and aiming at it is work. The icon stays
 * centred; what grows is the area that answers a click.
 */
.add-column-button {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
}

/*
 * Подпись слева, переключатель у правого края — по краю полей выше, чтобы диалог читался одной сеткой.
 * Вся строка кликабельна: это `label`, поэтому щелчок по надписи переключает.
 */
.add-column-switch {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  cursor: pointer;
  line-height: normal;
}

.column-head {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  cursor: pointer;
}

.column-type {
  color: var(--el-text-color-placeholder);
  font-size: 0.75rem;
  font-weight: 400;
}

/*
 * One line per cell, cut with an ellipsis. A hash or a long text otherwise makes one row as tall as
 * the screen, and a table where a row is a screen is not a table.
 *
 * It is a button because the cut is not the end of the story: clicking shows the whole value. A `title`
 * would only hold a little of it and cannot be selected or copied.
 */
.value-cell {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}

.value-cell:hover {
  text-decoration: underline;
  text-decoration-style: dotted;
  text-underline-offset: 3px;
}

.value-cell_null {
  color: var(--el-text-color-placeholder);
  cursor: default;
}

.value-cell_null:hover {
  text-decoration: none;
}

.foot {
  display: flex;
  justify-content: flex-end;
}

.actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

/*
 * Размер иконки задаётся здесь, а не в каждом месте: `el-icon` — это рамка, которая масштабирует
 * вложенный svg по своему размеру, поэтому одно правило держит все иконки экрана одинаковыми.
 */
.icon {
  width: 15px;
  height: 15px;
  font-size: 15px;
}

.actions-delete {
  color: var(--el-color-danger);
}
</style>
