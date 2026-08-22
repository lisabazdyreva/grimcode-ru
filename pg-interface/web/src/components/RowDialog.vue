<script setup lang="ts">
import { computed, ref, watch } from 'vue';

import type { Column } from '../api';
import { cellText } from '../labels';

const props = defineProps<{
  open: boolean;
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
const cleared = ref<Set<string>>(new Set());

watch(
  () => props.row,
  (row) => {
    draft.value = Object.fromEntries(
      props.columns.map((column) => [column.name, cellText(row?.[column.name])]),
    );
    cleared.value = new Set();
  },
  { immediate: true },
);

const editable = computed(() => props.columns.filter((column) => !props.primaryKey.includes(column.name)));
const keyColumns = computed(() => props.columns.filter((column) => props.primaryKey.includes(column.name)));

/**
 * Only what changed is sent.
 *
 * Sending every column would overwrite a value somebody else changed while this dialog was open, and
 * would also mean sending a timestamp back as text it may not parse to.
 */
function save(): void {
  const values: Record<string, unknown> = {};

  for (const column of editable.value) {
    const typed = draft.value[column.name] ?? '';
    const original = cellText(props.row?.[column.name]);
    if (typed === original) continue;

    // An emptied field means null where the column allows it, and an empty string where it does not:
    // a person clearing a `not null` text column means "make it empty", not "break the row".
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
    title="Строка"
    width="46rem"
    :close-on-click-modal="false"
    @update:model-value="emit('close')"
  >
    <el-form label-position="top">
      <el-form-item v-for="column in keyColumns" :key="column.name" :label="`${column.name} · ключ`">
        <el-input :model-value="draft[column.name]" disabled />
      </el-form-item>

      <el-form-item
        v-for="column in editable"
        :key="column.name"
        :label="`${column.name} · ${column.type}${column.nullable ? '' : ' · not null'}`"
      >
        <el-input
          v-model="draft[column.name]"
          type="textarea"
          :autosize="{ minRows: 1, maxRows: 8 }"
          :placeholder="column.nullable ? 'пусто = null' : ''"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('close')">Отмена</el-button>
      <el-button type="primary" :disabled="!changed" :loading="saving" @click="save">Сохранить</el-button>
    </template>
  </el-dialog>
</template>
