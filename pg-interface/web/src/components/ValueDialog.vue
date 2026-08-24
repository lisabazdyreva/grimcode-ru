<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';

import { cellText, shortType } from '../labels';

/**
 * One cell, in full.
 *
 * A table shows a line of a value; a uuid, a hash or a json document is longer than the line. The row
 * dialog holds the whole thing too, but it holds twelve of them at once — this is for the one value a
 * person is actually looking at, in a box they can select and copy from.
 */
const props = defineProps<{
  column: { name: string; type: string } | null;
  value: unknown;
}>();

const emit = defineEmits<{ close: [] }>();

const box = ref<{ textarea?: HTMLTextAreaElement } | null>(null);
const text = computed(() => cellText(props.value));
const lines = computed(() => text.value.split('\n').length);
const pretty = computed(() => {
  // A json value is stored as one line and reads as none: indented, it is a document again.
  if (typeof props.value !== 'object' || props.value === null) return null;
  return JSON.stringify(props.value, null, 2);
});

const shown = ref<'raw' | 'pretty'>('raw');
watch(() => props.column, () => (shown.value = pretty.value === null ? 'raw' : 'pretty'));

const body = computed(() => (shown.value === 'pretty' && pretty.value !== null ? pretty.value : text.value));

/**
 * Copying, with the fallback that matters here: this screen runs in a sandboxed frame, where the
 * clipboard API is not always allowed. When it is refused, the text is selected instead and the person
 * finishes with their own keyboard.
 */
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(body.value);
    ElMessage({ type: 'success', message: 'Значение скопировано' });
  } catch {
    box.value?.textarea?.select();
    ElMessage({ type: 'info', message: 'Выделено — скопируйте с клавиатуры' });
  }
}
</script>

<template>
  <el-dialog
    :model-value="column !== null"
    width="46rem"
    class="value-dialog"
    @update:model-value="emit('close')"
  >
    <template #header>
      <div class="head">
        <span class="head-name">{{ column?.name }}</span>
        <span class="head-type" :title="column?.type">{{ shortType(column?.type ?? '') }}</span>
        <span class="head-size">{{ text.length }} символов{{ lines > 1 ? `, ${lines} строк` : '' }}</span>
      </div>
    </template>

    <el-input
      ref="box"
      :model-value="body"
      type="textarea"
      readonly
      :autosize="{ minRows: 4, maxRows: 18 }"
      class="value"
    />

    <template #footer>
      <el-button
        v-if="pretty !== null"
        size="small"
        @click="shown = shown === 'pretty' ? 'raw' : 'pretty'"
      >
        {{ shown === 'pretty' ? 'Как в базе' : 'С отступами' }}
      </el-button>
      <el-button size="small" @click="copy">Копировать</el-button>
      <el-button size="small" type="primary" @click="emit('close')">Закрыть</el-button>
    </template>
  </el-dialog>
</template>

<style>
.value-dialog .el-textarea__inner {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8rem;
}
</style>

<style scoped>
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.head-name {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.95rem;
  font-weight: 600;
}

.head-type,
.head-size {
  color: var(--el-text-color-placeholder);
  font-size: 0.75rem;
}

.head-size {
  margin-left: auto;
  margin-right: 12px;
}
</style>
