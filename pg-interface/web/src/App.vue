<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
// The library's own wording, so the pager and the dialogs speak the language the rest of this screen does.
import russian from 'element-plus/es/locale/lang/ru.mjs';

import {
  ApiError,
  deleteRow,
  listDatabases,
  listTables,
  readRows,
  updateRow,
  type Column,
  type Filter,
  type RowsPage,
  type TableInfo,
} from './api';
import FilterPanel from './components/FilterPanel.vue';
import RowDialog from './components/RowDialog.vue';
import { CELL_LIMIT, cellText, rowCountLabel } from './labels';
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
      filters: view.value.filters.filter((filter) => filter.column !== ''),
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
              <el-button size="small">
                Фильтры<span v-if="view.filters.length > 0"> · {{ view.filters.length }}</span>
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
                  <span class="column-type">{{ column.type }}</span>
                </span>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item @click="sort(column.name)">
                      Сортировать{{ sortOf(column.name)?.direction === 'asc' ? ' по убыванию' : '' }}
                    </el-dropdown-item>
                    <el-dropdown-item @click="filterBy(column.name)">Фильтровать</el-dropdown-item>
                    <el-dropdown-item divided @click="hide(column.name)">Скрыть колонку</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>

            <template #default="{ row }">
              <span v-if="row[column.name] === null" class="cell-null">null</span>
              <span v-else class="cell" :title="cellText(row[column.name]).slice(0, CELL_LIMIT)">
                {{ cellText(row[column.name]).slice(0, CELL_LIMIT) }}
              </span>
            </template>
          </el-table-column>

          <!--
            The row's own actions: an icon to open it, and everything that cannot be undone behind a
            menu. Two buttons side by side put "delete" under the cursor of somebody aiming at "edit",
            and in a narrow column they wrapped onto two lines.
          -->
          <el-table-column v-if="changeable" label="" width="84" fixed="right" align="center">
            <template #default="{ row }">
              <div class="actions">
                <el-button size="small" text title="Открыть строку" @click="editing = row">
                  <svg viewBox="0 0 16 16" class="icon" aria-hidden="true">
                    <path
                      d="M10.5 1.5l4 4-8 8H2.5v-4l8-8z"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linejoin="round"
                    />
                  </svg>
                </el-button>

                <el-dropdown trigger="click">
                  <el-button size="small" text title="Ещё">
                    <svg viewBox="0 0 16 16" class="icon" aria-hidden="true">
                      <circle cx="3" cy="8" r="1.3" fill="currentColor" />
                      <circle cx="8" cy="8" r="1.3" fill="currentColor" />
                      <circle cx="13" cy="8" r="1.3" fill="currentColor" />
                    </svg>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item class="actions-delete" @click="remove(row)">
                        Удалить строку
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
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

  <RowDialog
    :open="editing !== null"
    :columns="page?.columns ?? []"
    :primary-key="page?.primaryKey ?? []"
    :row="editing"
    :saving="saving"
    @close="editing = null"
    @save="save"
  />
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
 * the screen, and a table where a row is a screen is not a table; the whole value is in the row's own
 * dialog, and the title attribute shows it on hover.
 */
.cell {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.cell-null {
  color: var(--el-text-color-placeholder);
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

.icon {
  width: 14px;
  height: 14px;
}

.actions-delete {
  color: var(--el-color-danger);
}
</style>
