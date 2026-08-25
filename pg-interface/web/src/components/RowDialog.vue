<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { Column } from '../api';
import { cellText, shortType } from '../labels';

const props = defineProps<{
  open: boolean;
  schema: string;
  table: string;
  columns: Column[];
  primaryKey: string[];
  row: Record<string, unknown> | null;
  saving: boolean;
  /**
   * `edit` shows the row it was given; `insert` shows an empty form for a new one.
   *
   * One dialog rather than two, because the difference is small and lives in three places: whether the
   * key is written or read, what an empty field means, and which columns appear at all.
   */
  mode?: 'edit' | 'insert';
}>();

const emit = defineEmits<{
  close: [];
  save: [values: Record<string, unknown>];
}>();

/** What is being typed, as text. Converted back on save, so an empty field can mean null. */
const draft = ref<Record<string, string>>({});

watch(
  () => props.row,
  (row) => {
    draft.value = Object.fromEntries(
      props.columns.map((column) => [column.name, cellText(row?.[column.name])]),
    );
  },
  { immediate: true },
);

const inserting = computed(() => props.mode === 'insert');

/**
 * Which columns a new row may carry: everything the database does not fill in by itself.
 *
 * A generated column — an identity, or one computed from others — is left out of the form entirely,
 * because the server refuses a new row that carries one.
 */
const writable = computed(() => props.columns.filter((column) => column.generated !== true));

const keyColumns = computed(() =>
  inserting.value ? [] : props.columns.filter((column) => props.primaryKey.includes(column.name)),
);

const editable = computed(() =>
  inserting.value
    ? writable.value
    : props.columns.filter((column) => !props.primaryKey.includes(column.name)),
);

/** What an empty field will do, said in the label rather than discovered after saving. */
function emptyMeans(column: Column): string {
  if (column.hasDefault === true) return 'пусто = по умолчанию';
  if (column.nullable) return 'пусто = null';
  return 'обязательно';
}

/**
 * Which columns get a box to write in and which get a line.
 *
 * Every field used to be a growing textarea, which gave a uuid the same tall box with a resize corner
 * as a template body — and made a form of eight short values look like a wall. A line is the default;
 * a box is for the types that really do hold something long, or for a value that already is.
 */
const LONG_TYPES = /text|json|xml|bytea/i;

function isLong(column: Column): boolean {
  return LONG_TYPES.test(column.type) && (draft.value[column.name] ?? '').length > 80;
}

/**
 * What is sent, and it differs by mode.
 *
 * Editing sends the columns that changed and nothing else, so two people editing one row do not
 * overwrite each other. Inserting sends what was filled in: a field left empty on a column with a
 * default is **omitted**, which is the only way the database's own value applies.
 */
function save(): void {
  const values: Record<string, unknown> = {};

  if (inserting.value) {
    for (const column of writable.value) {
      const typed = draft.value[column.name] ?? '';

      if (typed === '') {
        if (column.hasDefault === true) continue;
        values[column.name] = column.nullable ? null : '';
        continue;
      }

      values[column.name] = typed;
    }

    emit('save', values);
    return;
  }

  for (const column of editable.value) {
    const typed = draft.value[column.name] ?? '';
    if (typed === cellText(props.row?.[column.name])) continue;

    // An emptied field means null where the column allows it, and an empty string where it does not: a
    // person clearing a `not null` text column means "make it empty", not "break the row".
    values[column.name] = typed === '' ? (column.nullable ? null : '') : typed;
  }

  emit('save', values);
}

const changed = computed(() =>
  inserting.value ||
  editable.value.some((column) => (draft.value[column.name] ?? '') !== cellText(props.row?.[column.name])),
);
</script>

<template>
  <el-dialog
    :model-value="open"
    width="40rem"
    :close-on-click-modal="false"
    class="row-dialog"
    @update:model-value="emit('close')"
  >
    <template #header>
      <div class="head">
        <span class="head-title">{{ inserting ? 'Новая строка' : 'Строка' }}</span>
        <span class="head-where">{{ schema }}.{{ table }}</span>
      </div>
    </template>

    <section v-if="keyColumns.length > 0" class="block">
      <h2 class="block-title">Ключ — только чтение</h2>
      <div class="field" v-for="column in keyColumns" :key="column.name">
        <div class="field-label">
          <span class="field-name">{{ column.name }}</span>
          <span class="field-type" :title="column.type">{{ shortType(column.type) }}</span>
        </div>
        <el-input :model-value="draft[column.name]" size="small" disabled />
      </div>
    </section>

    <section class="block">
      <div class="field" v-for="column in editable" :key="column.name">
        <div class="field-label">
          <span class="field-name">{{ column.name }}</span>
          <span class="field-type" :title="column.type">{{ shortType(column.type) }}</span>
          <span v-if="inserting" class="field-hint">{{ emptyMeans(column) }}</span>
          <span v-else-if="column.nullable" class="field-hint">пусто = null</span>
        </div>
        <el-input
          v-model="draft[column.name]"
          size="small"
          :type="isLong(column) ? 'textarea' : 'text'"
          :autosize="isLong(column) ? { minRows: 3, maxRows: 10 } : undefined"
        />
      </div>
    </section>

    <template #footer>
      <el-button size="small" @click="emit('close')">Отмена</el-button>
      <el-button size="small" type="primary" :disabled="!changed" :loading="saving" @click="save">
        {{ inserting ? 'Добавить' : 'Сохранить' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<!--
  Not scoped: element-plus renders the dialog outside this component's tree, so a scoped rule would
  never reach its body. A wide table has thirty columns, and without this the dialog grows past the
  screen and takes its own buttons with it.
-->
<style>
.row-dialog .el-dialog__body {
  max-height: 62vh;
  overflow: auto;
}

.row-dialog .el-dialog__header {
  margin-right: 0;
}
</style>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.head-title {
  font-size: 1rem;
  font-weight: 600;
}

.head-where {
  color: var(--el-text-color-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}

.block + .block {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.block-title {
  margin: 0 0 8px;
  color: var(--el-text-color-secondary);
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.field + .field {
  margin-top: 10px;
}

.field-label {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 3px;
}

.field-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
}

.field-type,
.field-hint {
  color: var(--el-text-color-placeholder);
  font-size: 0.72rem;
}

.field-hint {
  margin-left: auto;
}
</style>
