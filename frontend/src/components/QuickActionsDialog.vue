<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import Dialog from 'primevue/dialog';
import type { QuickAction, QuickActionId } from '../quick-actions';

const props = defineProps<{ visible: boolean; actions: QuickAction[] }>();
const emit = defineEmits<{ 'update:visible': [visible: boolean]; execute: [id: QuickActionId]; 'after-hide': [] }>();
const query = ref('');
const search = ref<HTMLInputElement>();
const activeId = ref<QuickActionId>();
const filtered = computed(() => props.actions.filter(action => `${action.title} ${action.description} ${action.id}`.toLowerCase().includes(query.value.trim().toLowerCase())));
const groups = computed(() => ['Events', 'Scenarios', 'Diagram history', 'Tabs', 'Data', 'Diagram', 'Clipboard'].map(title => ({ title, actions: filtered.value.filter(action => action.group === title) })).filter(group => group.actions.length));
watch(() => props.visible, visible => {
  if (visible) { query.value = ''; activeId.value = props.actions.find(action => !action.disabled)?.id; }
}, { flush: 'sync' });
watch(filtered, actions => { activeId.value = actions.find(action => !action.disabled)?.id; });

function focusSearch() {
  search.value?.focus();
}
defineExpose({ focusSearch });

function execute(action: QuickAction) {
  if (!action.disabled) emit('execute', action.id);
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.defaultPrevented) return;
  if (event.key === 'Enter') {
    event.preventDefault();
    const action = filtered.value.find(action => action.id === activeId.value);
    if (action) execute(action);
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const enabled = filtered.value.filter(action => !action.disabled);
    const index = enabled.findIndex(action => action.id === activeId.value);
    activeId.value = enabled[Math.max(0, Math.min(enabled.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.id;
    void nextTick(() => document.getElementById(`quick-action-${activeId.value}`)?.scrollIntoView?.({ block: 'nearest' }));
  }
}
</script>

<template>
  <Dialog :visible="visible" modal dismissable-mask header="Quick actions" class="quick-actions-dialog" :draggable="false" :style="{ width: 'min(580px, 94vw)' }" @update:visible="emit('update:visible', $event)" @show="nextTick(focusSearch)" @after-hide="emit('after-hide')">
    <div class="quick-search"><i class="pi pi-search" aria-hidden="true" /><input ref="search" v-model="query" autofocus aria-label="Search quick actions" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="quick-action-list" :aria-activedescendant="activeId ? `quick-action-${activeId}` : undefined" placeholder="Search actions or shortcuts…" @keydown="onKeydown" /></div>
    <div id="quick-action-list" class="quick-action-list" role="listbox" aria-label="Quick actions">
      <div v-for="group in groups" :key="group.title" role="group" :aria-label="group.title">
        <p class="quick-group eyebrow" aria-hidden="true">{{ group.title }}</p>
        <div v-for="action in group.actions" :id="`quick-action-${action.id}`" :key="action.id" role="option" :aria-selected="action.id === activeId" :aria-disabled="action.disabled" :class="['quick-action', { active: action.id === activeId, disabled: action.disabled }]" @mousemove="!action.disabled && (activeId = action.id)" @mousedown.prevent @click="execute(action)">
          <i :class="['pi', action.icon]" aria-hidden="true" /><span><strong>{{ action.title }}</strong><small>{{ action.description }}</small></span><kbd>{{ action.shortcut ?? action.id }}</kbd>
        </div>
      </div>
    </div>
    <p v-if="!filtered.length" class="quick-empty" role="status">No actions match “{{ query }}”.</p>
    <template #footer><div class="quick-help"><span><kbd>↑</kbd> <kbd>↓</kbd> Select</span><span><kbd>Enter</kbd> Run</span><span><kbd>Esc</kbd> Close</span></div></template>
  </Dialog>
</template>
