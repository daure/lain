<script setup lang="ts">
import { inject, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import { captureChart, chartFilename, downloadChart, encodeChart, type ExportFormat, type ExportScope } from '../chart-export';
import { chartDownloadKey } from '../chart-download';

const props = defineProps<{ viewport: () => HTMLElement | undefined; title: string; width: number; height: number; scenario: boolean; scenarioTitle?: string }>();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const menu = ref<HTMLElement>();
const menuId = `chart-export-${useId()}`;
const open = ref(false);
const busy = ref(false);
const error = ref('');
const scope = ref<ExportScope>(props.scenario ? 'scenario' : 'all');
const formats: ExportFormat[] = ['svg', 'png', 'pdf'];
const serverDownload = inject(chartDownloadKey, undefined);

async function toggle() {
  open.value = !open.value;
  error.value = '';
  if (open.value) {
    await nextTick();
    menu.value?.querySelector<HTMLButtonElement>('button')?.focus();
  }
}

function close(restoreFocus = false) {
  open.value = false;
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}

function outside(event: PointerEvent) {
  if (event.target instanceof Node && !root.value?.contains(event.target)) close();
}

function focusOut(event: FocusEvent) {
  if (event.relatedTarget instanceof Node && !root.value?.contains(event.relatedTarget)) close();
}

function keydown(event: KeyboardEvent) {
  if (!open.value) return;
  event.stopPropagation();
  if (event.key === 'Escape' || (event.ctrlKey && event.key === '[')) {
    event.preventDefault();
    close(true);
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const buttons = [...menu.value!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const target = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[target]?.focus();
}

async function exportChart(format: ExportFormat) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (serverDownload) await serverDownload(format, scope.value);
    else {
      await document.fonts?.ready;
      const viewport = props.viewport();
      if (!viewport) throw new Error('No chart is available to export.');
      const chart = captureChart(viewport, scope.value, props.title, props.width, props.height);
      const filename = chartFilename(chart.title, format, scope.value === 'scenario' ? props.scenarioTitle : undefined);
      downloadChart(await encodeChart(chart, format), filename);
    }
    close(true);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'The chart could not be exported.';
  } finally { busy.value = false; }
}

watch(() => props.scenario, scenario => { scope.value = scenario ? 'scenario' : 'all'; });
onMounted(() => document.addEventListener('pointerdown', outside, true));
onUnmounted(() => document.removeEventListener('pointerdown', outside, true));
</script>

<template>
  <div ref="root" class="chart-export" @keydown="keydown" @focusout="focusOut">
    <button ref="trigger" class="export-trigger" aria-label="Export chart" title="Export chart" aria-haspopup="menu" :aria-expanded="open" :aria-controls="open ? menuId : undefined" @click="toggle">
      <i class="pi pi-download" aria-hidden="true" />
    </button>
    <div v-if="open" :id="menuId" ref="menu" class="export-menu" data-chart-export-menu role="menu" aria-label="Export chart" :aria-busy="busy">
      <div v-if="scenario" class="export-scope" role="group" aria-label="Export scope">
        <button v-for="choice in (['scenario', 'all'] as const)" :key="choice" role="menuitemradio" :aria-checked="scope === choice" :disabled="busy" @click="scope = choice">
          <i :class="scope === choice ? 'pi pi-check' : 'empty-check'" aria-hidden="true" />{{ choice === 'scenario' ? 'Scenario only' : 'All scenarios' }}
        </button>
      </div>
      <div v-if="scenario" class="export-divider" role="separator" />
      <button v-for="format in formats" :key="format" class="export-format" role="menuitem" :disabled="busy" @click="exportChart(format)">
        <span>{{ format.toUpperCase() }}</span><small>{{ format === 'svg' ? 'Vector image' : format === 'png' ? 'Image' : 'Document' }}</small>
      </button>
      <p v-if="error" class="export-error" role="alert">{{ error }}</p>
    </div>
  </div>
</template>

<style scoped>
.chart-export{position:static}
.export-trigger{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:4px;background:transparent;color:var(--text)}
.export-trigger:hover,.export-trigger[aria-expanded="true"]{background:var(--soft)}
.export-menu{position:absolute;left:-1px;right:-1px;bottom:calc(100% + 6px);max-width:calc(100vw - 32px);max-height:calc(100dvh - 100px);overflow:auto;padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--surface);box-shadow:0 6px 24px #0003;color:var(--text)}
.export-menu button{display:flex;align-items:center;gap:10px;width:100%;height:auto;min-height:36px;padding:8px 10px;border:0;border-radius:4px;background:transparent;color:var(--text);text-align:left;font-size:.82rem}
.export-menu button:hover,.export-menu button:focus-visible{background:var(--soft)}
.export-menu button[aria-checked="true"]{color:var(--blue)}
.export-menu button:disabled{opacity:.5;cursor:default}
.export-scope .pi,.empty-check{width:14px;font-size:12px}
.export-divider{height:1px;background:var(--line);margin:6px 0}
.export-format{justify-content:space-between}
.export-format small{color:var(--muted);font-size:.72rem}
.export-error{margin:6px 10px;font-size:.78rem;line-height:1.4;overflow-wrap:anywhere;color:var(--danger,#ad3549)}
@media(max-width:700px){.export-trigger{width:30px;height:30px}}
</style>
