<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import ProgressSpinner from 'primevue/progressspinner';
import HighlightedText from './HighlightedText.vue';
import type { ExplanationSummary } from '../model';
import type { DeletedExplanation } from '../library';
import { arrowKeyActions } from '../quick-actions';

const props = defineProps<{ summaries: ExplanationSummary[]; loading: boolean; selecting: boolean; error: string; selectionError: string; remove: (item: ExplanationSummary) => Promise<DeletedExplanation> }>();
const emit = defineEmits<{ select: [id: string]; retry: []; deleted: [items: DeletedExplanation[]] }>();
const state = defineModel<{ query: string; selectedId: string; scrollTop: number }>('state', { required: true });
const grid = ref<HTMLElement>();
const scroller = ref<HTMLElement>();
const search = ref<HTMLInputElement>();
const deleteTarget = ref<ExplanationSummary | null>(null);
const deleteAllTargets = ref<ExplanationSummary[] | null>(null);
const deleteDialog = ref(false);
const deleting = ref(false);
const deleteError = ref('');
let restoring = true;
let restoreCardFocus = !!state.value.selectedId;
const query = ref(state.value.query);
const selectedId = ref(state.value.selectedId);
let savedScroll = state.value.scrollTop;
const searchTerm = computed(() => query.value.trim());
const filtered = computed(() => {
  const term = searchTerm.value.toLowerCase();
  return props.summaries.filter(item => item.title.toLowerCase().includes(term) || item.description.toLowerCase().includes(term));
});
const cards = () => [...(grid.value?.querySelectorAll<HTMLButtonElement>('.explanation-card') ?? [])];

function focusCard(position: number, reveal = true) {
  const card = cards()[position];
  if (!card) return;
  card.focus({ preventScroll: true });
  if (reveal) card.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function focusSelectedCard(clearSearch = false) {
  if (clearSearch && query.value) {
    query.value = '';
    void nextTick(() => focusSelectedCard());
    return;
  }
  if (filtered.value.length) focusCard(Math.max(0, filtered.value.findIndex(item => item.id === selectedId.value)));
  else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

function rememberScroll() {
  if (!restoring && !props.loading && !props.selecting && !props.error && grid.value && scroller.value) {
    savedScroll = scroller.value.scrollTop;
  }
}

function openExplanation(id: string) {
  if (props.selecting || deleteDialog.value) return;
  selectedId.value = id;
  savedScroll = scroller.value?.scrollTop ?? 0;
  saveState();
  restoring = true;
  emit('select', id);
}

function confirmDeletion(item: ExplanationSummary) {
  if (props.selecting || deleteDialog.value) return;
  selectedId.value = item.id;
  deleteTarget.value = { ...item };
  deleteAllTargets.value = null;
  deleteError.value = '';
  deleteDialog.value = true;
}

function confirmDeleteAll() {
  if (props.loading || props.error || props.selecting || deleteDialog.value || !props.summaries.length) return;
  deleteTarget.value = null;
  deleteAllTargets.value = props.summaries.map(item => ({ ...item }));
  deleteError.value = '';
  deleteDialog.value = true;
}

async function deleteExplanation() {
  const items = deleteAllTargets.value ?? (deleteTarget.value ? [deleteTarget.value] : []);
  if (!items.length || deleting.value || deleteError.value) return;
  deleting.value = true;
  const completed: DeletedExplanation[] = [];
  try {
    for (const item of items) {
      completed.push(await props.remove(item));
    }
    deleteDialog.value = false;
  } catch (cause) {
    const progress = deleteAllTargets.value ? `Deleted ${completed.length} of ${items.length} explanations. ` : '';
    deleteError.value = `${progress}${(cause as Error).message} Close this dialog and check the library before trying again.`;
    void nextTick(() => document.querySelector<HTMLButtonElement>('#delete-explanation-dialog [autofocus]')?.focus());
  } finally {
    deleting.value = false;
    if (completed.length) emit('deleted', completed);
  }
}

function restoreDeleteFocus() {
  if (filtered.value.length) focusSelectedCard();
  else search.value?.focus({ preventScroll: true });
}

function saveState() {
  state.value = { query: query.value, selectedId: selectedId.value, scrollTop: savedScroll };
}

watch(query, () => { savedScroll = 0; }, { flush: 'sync' });
onBeforeUnmount(saveState);

watch([filtered, () => props.loading || props.selecting || !!props.error], () => {
  if (!filtered.value.some(item => item.id === selectedId.value)) selectedId.value = filtered.value[0]?.id ?? '';
  void nextTick(() => {
    if (props.loading || props.selecting || props.error) return;
    if (scroller.value) scroller.value.scrollTop = savedScroll;
    if (restoreCardFocus || document.activeElement === document.body) focusCard(Math.max(0, filtered.value.findIndex(item => item.id === selectedId.value)), false);
    restoreCardFocus = false;
    restoring = false;
  });
}, { immediate: true, flush: 'post' });

function handleKeydown(event: KeyboardEvent) {
  if (deleteDialog.value) return;
  if (event.key === '/') {
    event.preventDefault();
    search.value?.focus();
    return;
  }
  if (props.loading || props.selecting || props.error) return;
  const key = arrowKeyActions[event.key] ?? event.key;
  if (!['h', 'j', 'k', 'l', 'Enter'].includes(key)) return;
  const buttons = cards();
  if (!buttons.length) return;
  const position = Math.max(0, filtered.value.findIndex(item => item.id === selectedId.value));
  if (key === 'Enter') {
    if (event.target instanceof Element && event.target.closest('button') && !event.target.closest('.explanation-card')) return;
    event.preventDefault();
    if (!event.repeat) openExplanation(filtered.value[position]!.id);
    return;
  }
  const firstTop = buttons[0]!.getBoundingClientRect().top;
  const nextRow = buttons.findIndex(card => card.getBoundingClientRect().top > firstTop + 1);
  const columns = nextRow > 0 ? nextRow : buttons.length;
  const offset = { h: -1, l: 1, j: columns, k: -columns }[key as 'h' | 'j' | 'k' | 'l'];
  event.preventDefault();
  if (key === 'j' && Math.floor(position / columns) === Math.floor((buttons.length - 1) / columns)) return;
  const target = key === 'j' ? Math.min(position + offset, buttons.length - 1) : position + offset;
  if (target < 0 || target >= buttons.length) return;
  focusCard(target);
}

function onSearchKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.metaKey || event.altKey || event.shiftKey) return;
  if (event.ctrlKey) {
    if (event.key.toLowerCase() === 'c') {
      event.preventDefault(); event.stopPropagation();
      query.value = '';
    }
    return;
  }
  if ((event.key === 'ArrowDown' || event.key === 'Enter') && filtered.value.length) {
    event.preventDefault(); event.stopPropagation();
    focusCard(0);
  }
}

defineExpose({ handleKeydown, focusSelectedCard });
</script>

<template>
  <main class="library-view" :aria-busy="loading || selecting">
    <div class="library-content library-toolbar">
    <div class="library-heading"><p class="eyebrow">Your explanation library</p><h1>Understand the path.<br><span class="muted">See the data behind it.</span></h1><p class="muted">Recorded scenarios, published by your agent. Walk through what happened, one event at a time.</p></div>
    <label class="library-search"><i class="pi pi-search" aria-hidden="true" /><input ref="search" v-model="query" type="search" aria-label="Search explanations" placeholder="Search titles and descriptions" @keydown="onSearchKeydown"><kbd aria-hidden="true">/</kbd></label>
    <div v-if="!loading && !error" class="library-results-row">
      <p class="muted library-results" role="status">{{ filtered.length }} {{ filtered.length === 1 ? 'explanation' : 'explanations' }}{{ searchTerm ? ' found' : '' }}</p>
      <Button v-if="summaries.length" class="delete-all-explanations" label="Delete all" icon="pi pi-trash" severity="danger" text size="small" :disabled="selecting || deleteDialog" aria-controls="delete-explanation-dialog" :aria-expanded="deleteDialog && !!deleteAllTargets" @click="confirmDeleteAll" />
    </div>
    </div>
    <div ref="scroller" class="library-scroll" role="region" aria-label="Explanation cards" @scroll="rememberScroll">
    <div class="library-content library-card-content">
    <div v-if="loading" class="placeholder" role="status"><ProgressSpinner style="width: 40px; height: 40px" /><h2>Loading your library…</h2></div>
    <div v-else-if="error" class="placeholder error-state" role="alert"><i class="pi pi-exclamation-circle" /><h2>Could not load the library</h2><p>{{ error }}</p><Button label="Retry connection" icon="pi pi-refresh" @click="emit('retry')" /></div>
    <template v-else>
      <div v-if="selectionError" class="inline-error" role="alert">{{ selectionError }}</div>
      <div v-if="!summaries.length" class="placeholder"><div class="empty-icon"><i class="pi pi-sitemap" /></div><h2>A place for the whole story</h2><p>Nothing published yet. Ask your agent to publish an explanation through Lain’s MCP tools.</p><p class="muted">To explore an example, run <code>lain demo</code>.</p></div>
      <template v-else>
        <div v-if="!filtered.length" class="placeholder library-empty"><h2>No matching explanations</h2><p>Try another title or description.</p></div>
        <div v-else ref="grid" class="library-grid" aria-label="Explanations">
          <div v-for="item in filtered" :key="item.id" class="explanation-card-wrap">
          <button class="explanation-card" :data-explanation-id="item.id" :tabindex="item.id === selectedId ? 0 : -1" @focus="selectedId = item.id" @click="openExplanation(item.id)">
            <h2><HighlightedText :text="item.title" :query="searchTerm" /></h2><p><HighlightedText :text="item.description" :query="searchTerm" /></p>
            <div class="card-bottom"><span>{{ item.diagramCount }} diagrams · {{ item.scenarioCount }} scenarios</span><i class="pi pi-arrow-right" /></div>
          </button>
          <button type="button" class="delete-explanation" :aria-label="`Delete ${item.title}`" :title="`Delete ${item.title}`" aria-controls="delete-explanation-dialog" :aria-expanded="deleteDialog && deleteTarget?.id === item.id" :disabled="selecting" @focus="selectedId = item.id" @click="confirmDeletion(item)"><i class="pi pi-trash" aria-hidden="true" /></button>
          </div>
        </div>
      </template>
    </template>
    </div>
    </div>
    <Dialog id="delete-explanation-dialog" v-model:visible="deleteDialog" modal :dismissable-mask="!deleting" :header="deleteAllTargets ? 'Delete all explanations?' : 'Delete explanation?'" :closable="false" :close-on-escape="!deleting" :draggable="false" :style="{ width: 'min(480px, 94vw)' }" aria-describedby="delete-explanation-description" @after-hide="restoreDeleteFocus">
      <p v-if="deleteAllTargets" id="delete-explanation-description" class="delete-description">Delete all {{ deleteAllTargets.length }} explanations in your library and all their recorded scenarios, including explanations hidden by search? You can undo for 8 seconds from the notification.</p>
      <p v-else id="delete-explanation-description" class="delete-description">Delete “{{ deleteTarget?.title }}” and all its recorded scenarios? You can undo for 8 seconds from the notification.</p>
      <p v-if="deleteError" class="inline-error" role="alert">{{ deleteError }}</p>
      <template #footer>
        <Button :label="deleteError ? 'Close' : 'Cancel'" severity="secondary" outlined autofocus :disabled="deleting" @click="deleteDialog = false" />
        <Button v-if="!deleteError" :label="deleteAllTargets ? 'Delete all explanations' : 'Delete explanation'" icon="pi pi-trash" severity="danger" :loading="deleting" :disabled="deleting" @click="deleteExplanation" />
      </template>
    </Dialog>
  </main>
</template>

<style scoped>
.library-content{width:100%;max-width:1250px;margin:0 auto;padding:0 32px}
.library-toolbar{flex-shrink:0;padding-top:28px;padding-bottom:6px}
.library-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain}
.library-card-content{padding-top:6px;padding-bottom:32px}
.library-heading{margin-bottom:20px}
.library-heading>.eyebrow{margin-bottom:8px}
.library-heading h1{font-size:2.4rem;line-height:1.15;margin-bottom:12px}
.library-heading>p:last-child{max-width:none;margin-bottom:0}
@media(max-width:700px){.library-content{padding-inline:18px}.library-toolbar{padding-top:20px}.library-heading{margin-bottom:16px}.library-heading h1{font-size:2rem}}
.library-search{display:flex;align-items:center;gap:12px;padding:12px 16px;margin-bottom:12px;border:1px solid var(--line);border-radius:8px;color:var(--muted);background:var(--surface)}
.library-search:focus-within{border-color:var(--blue)}
.library-search input{width:100%;min-width:0;border:0;outline:0;background:transparent;color:var(--text)}
.library-results-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px;margin-bottom:8px}
.library-results{font-size:.85rem;margin:0}
.library-empty{border:0;background:color-mix(in srgb,var(--soft) 20%,transparent);padding:40px 24px}
.explanation-card:focus{border-color:var(--blue);outline:none}
.explanation-card-wrap{position:relative;display:flex;min-width:0}
.explanation-card{display:flex;flex-direction:column;align-items:stretch;width:100%;min-width:0}
.explanation-card h2{padding-right:44px;line-height:32px;overflow-wrap:anywhere}
.delete-explanation{position:absolute;top:25px;right:calc(25px - (32px - 1rem)/2);display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:6px;background:transparent;color:var(--muted)}
.delete-explanation:hover{background:var(--soft);color:var(--danger,#ad3549)}
.delete-explanation:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
.delete-description{overflow-wrap:anywhere}
</style>
