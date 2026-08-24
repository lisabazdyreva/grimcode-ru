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

const keyColumns = computed(() => props.columns.filter((column) => props.primaryKey.includes(column.name)));
const editable = computed(() => props.columns.filter((column) => !props.primaryKey.includes(column.name)));

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

/** The columns that changed, and nothing else: two people editing one row do not overwrite each other. */
function save(): void {
  const values: Record<string, unknown> = {};

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
        <span class="head-title">Строка</span>
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
          <span v-if="column.nullable" class="field-hint">пусто = null</span>
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
        Сохранить
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
