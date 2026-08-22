<script setup lang="ts">
import { computed } from 'vue';

import type { Column, Filter } from '../api';
import { CONDITION_LABELS, WITHOUT_VALUE } from '../labels';

const props = defineProps<{
  columns: Column[];
  filters: Filter[];
  combine: 'and' | 'or';
}>();

const emit = defineEmits<{
  update: [filters: Filter[], combine: 'and' | 'or'];
}>();

const byName = computed(() => new Map(props.columns.map((column) => [column.name, column])));

/**
 * Which conditions this column takes, as the server said when it described the table.
 *
 * Asked rather than guessed: the server is what refuses a condition that does not apply, so offering
 * a different list here would only produce refusals a person cannot act on.
 */
function conditionsOf(name: string): readonly string[] {
  return byName.value.get(name)?.conditions ?? [];
}

function add(): void {
  const first = props.columns[0];
  if (!first) return;

  const condition = conditionsOf(first.name)[0] ?? 'is';
  emit('update', [...props.filters, { column: first.name, condition, value: '' }], props.combine);
}

function remove(index: number): void {
  emit(
    'update',
    props.filters.filter((_, at) => at !== index),
    props.combine,
  );
}

function change(index: number, patch: Partial<Filter>): void {
  const next = props.filters.map((filter, at) => (at === index ? { ...filter, ...patch } : filter));

  // A column of another kind takes other conditions, so the old one would be refused: the first
  // condition of the new column is the honest default.
  if (patch.column !== undefined) {
    const allowed = conditionsOf(patch.column);
    const current = next[index];
    if (current && !allowed.includes(current.condition)) {
      current.condition = allowed[0] ?? current.condition;
    }
  }

  emit('update', next, props.combine);
}
</script>

<template>
  <div class="filters">
    <div v-if="filters.length > 0" class="filters-combine">
      <el-radio-group
        :model-value="combine"
        size="small"
        @update:model-value="emit('update', filters, $event as 'and' | 'or')"
      >
        <el-radio-button value="and" label="и" />
        <el-radio-button value="or" label="или" />
      </el-radio-group>
    </div>

    <div v-for="(filter, index) in filters" :key="index" class="filters-row">
      <el-select
        :model-value="filter.column"
        size="small"
        class="filters-column"
        @update:model-value="change(index, { column: $event as string })"
      >
        <el-option v-for="column in columns" :key="column.name" :value="column.name" :label="column.name" />
      </el-select>

      <el-select
        :model-value="filter.condition"
        size="small"
        class="filters-condition"
        @update:model-value="change(index, { condition: $event as string })"
      >
        <el-option
          v-for="condition in conditionsOf(filter.column)"
          :key="condition"
          :value="condition"
          :label="CONDITION_LABELS[condition] ?? condition"
        />
      </el-select>

      <el-input
        v-if="!WITHOUT_VALUE.has(filter.condition)"
        :model-value="String(filter.value ?? '')"
        size="small"
        class="filters-value"
        placeholder="значение"
        @update:model-value="change(index, { value: $event })"
      />
      <span v-else class="filters-value filters-value_absent">—</span>

      <el-button size="small" text @click="remove(index)">убрать</el-button>
    </div>

    <el-button size="small" @click="add">Добавить условие</el-button>
  </div>
</template>

<style scoped>
.filters {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 30rem;
}

.filters-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.filters-column,
.filters-condition {
  width: 11rem;
}

.filters-value {
  width: 12rem;
}

.filters-value_absent {
  color: var(--el-text-color-placeholder);
  text-align: center;
}
</style>
