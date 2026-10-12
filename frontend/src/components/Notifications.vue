<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import Button from 'primevue/button';
import Toast, { type ToastMessageOptions } from 'primevue/toast';
import { useToast } from 'primevue/usetoast';
import type { DeletedExplanation } from '../library';

const props = defineProps<{ restore: (item: DeletedExplanation) => Promise<void> }>();
const toast = useToast();
type UndoMessage = ToastMessageOptions & { undoId?: number };
const backups = new Map<number, DeletedExplanation[]>();
const restoring = ref(new Set<number>());
let nextId = 0;
const icons: Record<string, string> = { success: 'pi-check', error: 'pi-times-circle', warn: 'pi-exclamation-triangle' };

function deleted(items: DeletedExplanation[]) {
  const undoId = nextId++;
  backups.set(undoId, items);
  toast.add({ severity: 'success', summary: items.length === 1 ? 'Explanation deleted' : 'Explanations deleted',
    detail: items.length === 1 ? items[0]!.document.title : `${items.length} explanations`, life: 8000, undoId } as UndoMessage);
}

function release({ message }: { message: UndoMessage }) {
  if (message.undoId !== undefined) backups.delete(message.undoId);
}

async function undo(message: UndoMessage) {
  const id = message.undoId;
  if (id === undefined || restoring.value.has(id)) return;
  const items = backups.get(id);
  if (!items) return;
  backups.delete(id);
  restoring.value.add(id);
  let completed = 0;
  try {
    for (const item of items) {
      await props.restore(item);
      completed++;
    }
    toast.add({ severity: 'success', summary: items.length === 1 ? 'Explanation restored' : 'Explanations restored',
      detail: items.length === 1 ? items[0]!.document.title : `${completed} explanations`, life: 3000 });
  } catch (cause) {
    toast.add({ severity: 'error', summary: 'Undo failed',
      detail: `${items.length > 1 ? `Restored ${completed} of ${items.length} explanations. ` : ''}${(cause as Error).message} Check the library before trying again.`, life: 6000 });
  } finally {
    toast.remove(message);
    restoring.value.delete(id);
  }
}

onBeforeUnmount(() => backups.clear());
defineExpose({ deleted });
</script>

<template>
  <Toast position="top-right" :breakpoints="{ '500px': { width: 'calc(100vw - 32px)', right: '16px' } }" @close="release" @life-end="release">
    <template #message="{ message }">
      <i :class="['pi', 'p-toast-message-icon', icons[message.severity] ?? 'pi-info-circle']" aria-hidden="true" />
      <div class="p-toast-message-text notification-text">
        <span class="p-toast-summary">{{ message.summary }}</span>
        <div v-if="message.detail" class="p-toast-detail">{{ message.detail }}</div>
      </div>
      <Button v-if="message.undoId !== undefined" label="Undo" icon="pi pi-undo" size="small" severity="success" text class="notification-undo" :loading="restoring.has(message.undoId)" :disabled="restoring.has(message.undoId)" @click="undo(message)" />
    </template>
  </Toast>
</template>

<style scoped>
.notification-text{min-width:0;overflow-wrap:anywhere}
.notification-undo{flex-shrink:0;align-self:center}
</style>
