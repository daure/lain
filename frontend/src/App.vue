<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { useToast } from 'primevue/usetoast';
import GraphView from './components/GraphView.vue';
import DomainView from './components/DomainView.vue';
import SequenceView from './components/SequenceView.vue';
import ScenarioJump from './components/ScenarioJump.vue';
import StepInspector from './components/StepInspector.vue';
import StepNavigator from './components/StepNavigator.vue';
import QuickActionsDialog from './components/QuickActionsDialog.vue';
import FocusChrome from './components/FocusChrome.vue';
import FocusBreadcrumb from './components/FocusBreadcrumb.vue';
import ExplanationLibrary from './components/ExplanationLibrary.vue';
import ExplanationLinks from './components/ExplanationLinks.vue';
import ExplanationOverview from './components/ExplanationOverview.vue';
import ScenarioContext from './components/ScenarioContext.vue';
import ScenarioLabels from './components/ScenarioLabels.vue';
import ScenarioPreview from './components/ScenarioPreview.vue';
import Notifications from './components/Notifications.vue';
import type DiagramViewport from './components/DiagramViewport.vue';
import { arrowKeyActions, shiftedPanActions, isEditableTarget, quickActions, type QuickActionId } from './quick-actions';
import { useLibrary } from './library';
import { useNavigation } from './navigation';
import { useBrowserNavigation } from './browser-navigation';
import { diagramLayout } from './layout';
import { activateDiagramNode, diagramLinks } from './diagram-links';
import { useTheme } from './theme';
import { chartDownloadKey, chartExportUrl, downloadChartUrl } from './chart-download';
import { viewportStatesKey } from './viewport-state';
import { scenarioSections } from './explanation-structure';
import { useMobileSidebar } from './mobile-sidebar';

const { dark, toggleTheme } = useTheme();
const toast = useToast();
let yankDeadline = 0;
let firstEventDeadline = 0;
const drillRepeatSkipped = { i: false, o: false };
const library = useLibrary();
const { summaries, active, loading, selecting, error, selectionError, connection } = library;
const navigation = useNavigation();
const routes = useBrowserNavigation(library, navigation);
const { overview: showingOverview } = routes;
const { scenario, diagram, occurrence, index, history: walkedHistory, scenarioId } = navigation;
provide(viewportStatesKey, new Map());
const canvasStateKey = computed(() => `${active.value?.id}/${diagram.value?.id}/${scenario.value?.id}`);
const tabs = ['Diagram', 'Domain'] as const;
const selectedTab = ref(0);
provide(chartDownloadKey, async (format, scope) => {
  if (!active.value || !diagram.value) throw new Error('No chart is available to export.');
  const url = chartExportUrl(active.value.id, selectedTab.value === 1 ? undefined : diagram.value.id,
    format, dark.value ? 'dark' : 'light', scope === 'scenario' ? scenarioId.value : undefined);
  await downloadChartUrl(url);
});
const dataOpen = ref(false);
const dataInspector = ref<InstanceType<typeof StepInspector>>();
const dataToggleButton = ref<HTMLButtonElement>();
const focusMode = ref(false);
const { mobile, open: mobileSidebarOpen, close: closeMobileSidebar, toggle: toggleMobileSidebar } = useMobileSidebar(focusMode);
const sidebarHidden = computed(() => focusMode.value || (mobile.value && !mobileSidebarOpen.value));
const diagramView = ref<{ canvas?: InstanceType<typeof DiagramViewport>; focusNode: (nodeId: string) => void }>();
const scenarioJump = ref<InstanceType<typeof ScenarioJump>>();
const domainView = ref<InstanceType<typeof DomainView>>();
const activeCanvas = computed(() => selectedTab.value === 0 ? diagramView.value?.canvas : domainView.value?.canvas);
const quickDialog = ref(false);
const quickActionsDialog = ref<InstanceType<typeof QuickActionsDialog>>();
const libraryView = ref<InstanceType<typeof ExplanationLibrary>>();
const overviewView = ref<InstanceType<typeof ExplanationOverview>>();
const overviewQueries = ref<Record<string, string>>({});
const scenarioPreview = ref<InstanceType<typeof ScenarioPreview>>();
const notifications = ref<InstanceType<typeof Notifications>>();
const libraryState = ref({ query: '', selectedId: '', scrollTop: 0 });
const scenariosRegion = ref<HTMLElement>();
const quickButton = ref<HTMLButtonElement>();
let focusOrigin: HTMLElement | null = null;
let pendingDialog = false;
let pendingJumpHints = false;
let pendingPreview = false;
let modalClosing = false;
const ownedDialogSelector = '.quick-actions-dialog[aria-modal="true"]';
const sections = computed(() => active.value ? scenarioSections(active.value.document) : []);
const visualScenarios = computed(() => sections.value.flatMap(section => section.scenarios));
const scenarioPosition = computed(() => visualScenarios.value.findIndex(item => item.id === scenarioId.value));
const actions = computed(() => quickActions.map(action => ({ ...action, ...(action.id === 'H' && activeCanvas.value ? { shortcut: 'Palette only' } : {}), disabled: !active.value || !scenario.value || (showingOverview.value && action.id !== 'j' && action.id !== 'k') || ({
  h: index.value === 0, l: index.value === (scenario.value?.occurrences.length ?? 0) - 1,
  gg: index.value === 0, G: index.value === (scenario.value?.occurrences.length ?? 0) - 1,
   j: !showingOverview.value && scenarioPosition.value === visualScenarios.value.length - 1, k: showingOverview.value,
   d: false,
   i: !navigation.canDrillBack.value, o: !navigation.canDrillForward.value,
  H: false,
   m: false,
   n: false,
   ',': !dataOpen.value || !dataInspector.value?.canPrevious,
    '.': !dataOpen.value || !dataInspector.value?.canNext,
   "'": !dataOpen.value, '/': !dataOpen.value,
  '[': selectedTab.value === 0, ']': selectedTab.value === tabs.length - 1,
  ys: !scenario.value, yp: !occurrence.value, yd: !diagram.value,
  '=': !activeCanvas.value, '-': !activeCanvas.value, ';': !activeCanvas.value,
  'pan-left': !activeCanvas.value, 'pan-down': !activeCanvas.value, 'pan-up': !activeCanvas.value, 'pan-right': !activeCanvas.value,
  '?': selectedTab.value !== 0 || !active.value?.document.scenarios.some(item => item.diagramId === diagram.value?.id && item.id !== scenarioId.value),
})[action.id] })));
watch(quickDialog, (next, previous) => {
  if (next) { domainView.value?.cancelNumberShortcut(); scenarioJump.value?.cancel(); }
  if (previous && !next) modalClosing = true;
}, { flush: 'sync' });
const inspectedNodeId = ref('');
const inspectedDiagramId = ref('');
const pickedOccurrenceId = ref<string | null>(null);
const inspectedEntityId = ref('');
const graph = computed(() => diagram.value && diagram.value.kind !== 'sequence' ? diagramLayout(diagram.value) : null);
const currentNode = computed(() => diagram.value?.nodes.find(node => node.id === occurrence.value?.nodeId));
const detailLinks = computed(() => active.value && diagram.value ? diagramLinks(active.value.document, diagram.value) : new Map());
const currentLocation = computed(() => `${currentNode.value?.label ?? ''} · ${index.value + 1} / ${scenario.value?.occurrences.length ?? 0}`);
const yankPaths = computed(() => {
  const diagramPath = `${active.value?.document.title} → ${diagram.value?.title}`;
  const scenarioPath = `${diagramPath} → ${scenario.value?.title}`;
  return { yd: diagramPath, ys: scenarioPath, yp: `${scenarioPath} → ${currentLocation.value}` };
});
const inspectedNode = computed(() => diagram.value?.nodes.find(node => node.id === inspectedNodeId.value));
const inspectedEntity = computed(() => active.value?.document.domain.entities.find(entity => entity.id === inspectedEntityId.value));
const nodeOccurrences = computed(() => navigation.occurrencesAtNode(inspectedNodeId.value).map(item => ({
  id: item.id,
  label: `Occurrence ${(scenario.value?.occurrences.findIndex(occurrence => occurrence.id === item.id) ?? 0) + 1} · ${item.trigger ?? 'No trigger captured'} · ${item.id}`,
})));
const visitedNodes = computed(() => walkedHistory.value.map(item => item.nodeId));
const visitedEdges = computed(() => walkedHistory.value.flatMap(item => item.incomingEdgeId ? [item.incomingEdgeId] : []));
const scenarioNodes = computed(() => scenario.value?.occurrences.map(item => item.nodeId) ?? []);
const scenarioEdges = computed(() => scenario.value?.occurrences.flatMap(item => item.incomingEdgeId ? [item.incomingEdgeId] : []) ?? []);
const connectionLabel = computed(() => ({ connected: 'Connected', connecting: 'Connecting', reconnecting: 'Reconnecting', offline: 'Not connected' })[connection.value]);

watch(active, (next, previous) => {
  if (!next || next.id !== previous?.id) {
    closeMobileSidebar(false);
    navigation.clearDrillHistory();
    selectedTab.value = 0;
    inspectedNodeId.value = ''; inspectedDiagramId.value = ''; pickedOccurrenceId.value = null; inspectedEntityId.value = '';
    if (!next) focusMode.value = false;
    return;
  }
  const focused = document.activeElement;
  if (inspectedDiagramId.value !== diagram.value?.id || !inspectedNode.value) { inspectedNodeId.value = ''; pickedOccurrenceId.value = null; }
  if (!nodeOccurrences.value.some(item => item.id === pickedOccurrenceId.value)) pickedOccurrenceId.value = null;
  if (!inspectedEntity.value) inspectedEntityId.value = '';
  if (next.revision > previous.revision) {
    const change = navigation.selectionChange.value;
    const detail = change === 'scenario' ? `Selected scenario was removed; moved to ${scenario.value?.title}.`
      : change === 'occurrence' ? `Selected step was removed; moved to ${currentNode.value?.label}.` : undefined;
    toast.add({ severity: 'info', summary: 'Explanation updated', detail, life: detail ? 6000 : 3000 });
  }
  void nextTick(() => {
    if (focused && focused !== document.body && !focused.isConnected) selectTab(selectedTab.value, true);
  });
});
watch(selectionError, message => {
  if (message && active.value) toast.add({ severity: 'error', summary: 'Explanation update failed', detail: `${message} The current view is unchanged.`, life: 6000 });
});
watch(scenarioId, (nextScenario, previousScenario) => {
  if (scenarioPreview.value?.scenarioId !== nextScenario) scenarioPreview.value?.dismiss();
  if (nextScenario !== previousScenario) { inspectedNodeId.value = ''; pickedOccurrenceId.value = null; }
  void nextTick(() => {
    const region = scenariosRegion.value;
    const selected = region?.querySelector<HTMLElement>('.scenario-link.selected');
    if (!region || !selected) return;
    const links = [...region.querySelectorAll('.scenario-link')];
    if (selected === links[0]) region.scrollTop = 0;
    else if (selected === links.at(-1)) region.scrollTop = Math.max(0, region.scrollHeight - region.clientHeight);
    else selected.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  });
});
watch(scenariosRegion, (region, _, onCleanup) => {
  if (!region) return;
  const update = () => region.style.setProperty('--sidebar-scrollbar-width', `${region.offsetWidth - region.clientWidth}px`);
  const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
  observer?.observe(region);
  const nav = region.querySelector('nav');
  if (nav) observer?.observe(nav);
  update();
  onCleanup(() => observer?.disconnect());
}, { flush: 'post' });

function restoreFocus() {
  if (!active.value) { libraryView.value?.focusSelectedCard(); return; }
  const origin = focusOrigin;
  const canRestore = origin?.isConnected && !origin.closest('[role="dialog"], [hidden], [inert]')
    && !origin.matches(':disabled, [aria-disabled="true"]') && origin.getClientRects().length;
  if (canRestore) {
    origin.focus({ preventScroll: true });
    if (document.activeElement === origin) return;
  }
  if (focusMode.value) selectTab(selectedTab.value, true);
  else quickButton.value?.focus({ preventScroll: true });
}

function showQuickActions() {
  closeMobileSidebar(false);
  scenarioPreview.value?.dismiss();
  activeCanvas.value?.cancelPan();
  if (quickDialog.value) { quickActionsDialog.value?.focusSearch(); return; }
  if (!modalClosing) {
    focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    quickDialog.value = true;
    return;
  }
  pendingDialog = true;
}

function afterDialogHide() {
  modalClosing = false;
  restoreFocus();
  const reopen = pendingDialog;
  const preview = pendingPreview;
  pendingDialog = false;
  pendingPreview = false;
  if (reopen) void nextTick(showQuickActions);
  else if (preview) void nextTick(() => { scenarioPreview.value?.dismiss(); executeAction('d'); });
  else if (pendingJumpHints) scenarioJump.value?.start();
  pendingJumpHints = false;
}

function selectTab(position: number, focus = false) {
  if (position < 0 || position >= tabs.length) return;
  const focusedInTabs = document.activeElement?.closest('.event-tabs');
  selectedTab.value = position;
  if (focus || focusedInTabs) void nextTick(() => document.querySelector<HTMLButtonElement>('.event-tabs [role="tab"][aria-selected="true"]')?.focus({ preventScroll: true }));
}

function openScenario(id: string) {
  closeMobileSidebar(false);
  scenarioPreview.value?.dismiss();
  routes.openScenario(id);
  void nextTick(() => {
    const heading = document.querySelector<HTMLElement>('.scenario-context h2');
    if (heading) heading.focus({ preventScroll: true });
    else if (mobile.value) selectTab(selectedTab.value, true);
  });
}

function showOverview() {
  closeMobileSidebar(showingOverview.value);
  scenarioPreview.value?.dismiss();
  focusMode.value = false;
  routes.showOverview();
  void nextTick(() => { if (scenariosRegion.value) scenariosRegion.value.scrollTop = 0; });
}

function toggleData() {
  const focusedInInspector = document.activeElement?.closest('#step-inspector');
  dataOpen.value = !dataOpen.value;
  if (!dataOpen.value && focusedInInspector) void nextTick(() => dataToggleButton.value?.focus({ preventScroll: true }));
}

function selectDataEntity(id: string) {
  inspectedEntityId.value = id;
  domainView.value?.focusEntity(id);
}

function inspectProperty(entityId: string, attributeId: string) {
  inspectedEntityId.value = entityId;
  dataOpen.value = true;
  void dataInspector.value?.focusProperty(entityId, attributeId);
}

function openDetail(targetScenarioId: string) {
  if (navigation.openDetail(targetScenarioId)) selectTab(0, true);
}

function jumpToOccurrence(targetScenarioId: string, occurrenceId: string) {
  routes.jumpToOccurrence(targetScenarioId, occurrenceId);
  selectTab(0, true);
  void nextTick(() => diagramView.value?.focusNode(occurrence.value!.nodeId));
}

function onTabKeydown(event: KeyboardEvent) {
  const position = { ArrowLeft: selectedTab.value - 1, ArrowRight: selectedTab.value + 1, Home: 0, End: tabs.length - 1 }[event.key];
  if (position === undefined || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
  event.preventDefault(); event.stopPropagation();
  selectTab(position, true);
}

function executeAction(id: QuickActionId, heldKey?: string) {
  if (actions.value.find(action => action.id === id)?.disabled !== false) return;
  if (id === 'd') {
    if (quickDialog.value) { pendingPreview = true; quickDialog.value = false; return; }
    const anchor = sidebarHidden.value ? undefined : scenariosRegion.value?.querySelector<HTMLElement>('.scenario-link.selected');
    if (scenario.value) scenarioPreview.value?.toggle(anchor ?? undefined, scenario.value);
    return;
  }
  if (id === 'j' || id === 'k') {
    const position = showingOverview.value ? -1 : scenarioPosition.value;
    const targetPosition = position + (id === 'j' ? 1 : -1);
    const target = visualScenarios.value[targetPosition];
    if (target) {
      const anchor = sidebarHidden.value ? undefined : scenariosRegion.value?.querySelectorAll<HTMLElement>('.scenario-link')[targetPosition];
      scenarioPreview.value?.follow(anchor, target);
      routes.openScenario(target.id);
    }
    else if (id === 'k') showOverview();
    if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
    return;
  }
  if (id === '?') {
    if (quickDialog.value) { pendingJumpHints = true; modalClosing = true; quickDialog.value = false; }
    else scenarioJump.value?.start();
    return;
  }
  if (id === 'n' || id === ',' || id === '.' || id === "'" || id === '/') {
    if (id === 'n') toggleData();
    else if (id === "'" || id === '/') dataInspector.value?.page(id === "'" ? -1 : 1);
    else dataInspector.value?.selectRelativeTab(id === ',' ? -1 : 1);
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === 'm') {
    scenarioPreview.value?.dismiss();
    const focusedChrome = document.activeElement?.closest('.app-header, .sidebar, .event-controls');
    focusMode.value = !focusMode.value;
    if (focusMode.value && focusedChrome) selectTab(selectedTab.value, true);
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === 'pan-left' || id === 'pan-down' || id === 'pan-up' || id === 'pan-right') {
    const [x, y] = { 'pan-left': [-187.5, 0], 'pan-down': [0, 187.5], 'pan-up': [0, -187.5], 'pan-right': [187.5, 0] }[id];
    void activeCanvas.value?.panBy(x!, y!, heldKey);
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === '=' || id === '-' || id === ';') {
    if (id === ';') void activeCanvas.value?.toggleFit();
    else void activeCanvas.value?.zoom(id === '=' ? 1.25 : .8);
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === 'ys' || id === 'yp' || id === 'yd') {
    void yankPath(id);
    if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
    return;
  }
  if (id === '[' || id === ']') {
    selectTab(selectedTab.value + (id === '[' ? -1 : 1));
    if (quickDialog.value) quickDialog.value = false;
    return;
  }
  if (id === 'i' || id === 'o') {
    if (routes.traverseDrill(id === 'i' ? -1 : 1)) selectTab(0, true);
    if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
    return;
  }
  if (id === 'H') {
    routes.reset(visualScenarios.value[0]!.id);
    selectTab(0, true);
  }
  else if (id === 'h' || id === 'l') navigation.step(id === 'h' ? -1 : 1);
  else if (id === 'gg' || id === 'G') navigation.selectOccurrence(scenario.value!.occurrences[id === 'gg' ? 0 : scenario.value!.occurrences.length - 1]!.id);
  if (quickDialog.value) { modalClosing = true; quickDialog.value = false; }
}

async function yankPath(id: 'ys' | 'yp' | 'yd') {
  const path = yankPaths.value[id];
  const label = { ys: 'Scenario path', yp: 'Full path', yd: 'Diagram path' }[id];
  try {
    await navigator.clipboard.writeText(path);
    toast.add({ severity: 'success', summary: `${label} copied to clipboard`, detail: path, life: 3000 });
  } catch {
    toast.add({ severity: 'error', summary: `${label} could not be copied`, detail: 'Clipboard access is unavailable or was denied. Check your browser permissions and try again.', life: 5000 });
  }
}

function onYankKeydown(event: KeyboardEvent): boolean {
  const awaitingYank = Date.now() < yankDeadline;
  yankDeadline = 0;
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey
    || (isEditableTarget(event.target) && !isLeavingDialogTarget(event.target)) || !active.value || !scenario.value) return false;
  const action = awaitingYank ? actions.value.find(action => action.id === `y${event.key}` && !action.disabled) : undefined;
  if (action) executeAction(action.id);
  else if (event.key === 'y') yankDeadline = Date.now() + 1000;
  else return false;
  event.preventDefault(); event.stopPropagation();
  return true;
}

function hasUnknownModal() {
  return !!document.querySelector('[aria-modal="true"]:not(.quick-actions-dialog)');
}

function isLeavingDialogTarget(target: EventTarget | null) {
  const dialog = target instanceof Element ? target.closest(ownedDialogSelector) : null;
  return !!dialog && !quickDialog.value;
}

function isSelectionOverlayTarget(target: EventTarget | null) {
  return target instanceof Element && !!target.closest('[role="listbox"], [role="option"], .p-select-overlay');
}

function canUseDomainNumbers(target: EventTarget | null) {
  const leavingTarget = isLeavingDialogTarget(target);
  return !showingOverview.value && selectedTab.value === 1 && !!active.value && !!scenario.value && !quickDialog.value && !pendingDialog && !hasUnknownModal()
    && (!isEditableTarget(target) || leavingTarget) && (!isSelectionOverlayTarget(target) || leavingTarget)
    && !document.querySelector('.p-select-overlay');
}

function canUseScenarioJump(target: EventTarget | null) {
  return !showingOverview.value && selectedTab.value === 0 && !!active.value && !!scenario.value && !quickDialog.value && !pendingDialog && !hasUnknownModal()
    && !isEditableTarget(target) && !isSelectionOverlayTarget(target) && !document.querySelector('.p-select-overlay, [data-chart-export-menu]');
}

function onOwnedKeydown(event: KeyboardEvent) {
  if (scenarioPreview.value?.handleKeydown(event)) return;
  if (!canUseScenarioJump(event.target)) scenarioJump.value?.cancel();
  else if (scenarioJump.value?.handleKeydown(event, () => canUseScenarioJump(document.activeElement))) {
    firstEventDeadline = 0;
    yankDeadline = 0;
    event.preventDefault(); event.stopPropagation();
    return;
  }
  if (document.querySelector('[data-chart-export-menu]')) return;
  if (event.defaultPrevented || event.isComposing || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !canUseDomainNumbers(event.target)) {
    domainView.value?.cancelNumberShortcut();
  } else if (domainView.value?.handleNumberShortcut(event, () => canUseDomainNumbers(document.activeElement))) {
    firstEventDeadline = 0;
    yankDeadline = 0;
    event.preventDefault(); event.stopPropagation();
    return;
  }
  if (event.key !== 'g') firstEventDeadline = 0;
  if (onYankKeydown(event)) return;
  if (event.defaultPrevented || event.isComposing) return;
  const escapeKey = event.key === 'Escape' || (event.key === '[' && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey);
  if (escapeKey) {
    if (event.repeat) return;
    const quickTarget = event.target instanceof Element && event.target.closest('.quick-actions-dialog');
    if (hasUnknownModal() || (isSelectionOverlayTarget(event.target) && !quickTarget)
      || document.querySelector('.p-select-overlay')) return;
    if (quickDialog.value || pendingDialog) {
      pendingDialog = false;
      quickDialog.value = false;
      event.preventDefault(); event.stopPropagation();
    } else if (mobileSidebarOpen.value) {
      closeMobileSidebar();
      event.preventDefault(); event.stopPropagation();
    } else if (!modalClosing) {
      if (!active.value) libraryView.value?.focusSelectedCard(!!document.activeElement?.closest('.explanation-card'));
      else {
        const focused = document.activeElement;
        if (focused && focused !== document.body && focused !== document.documentElement && (focused instanceof HTMLElement || focused instanceof SVGElement)) focused.blur();
        else routes.back();
      }
      event.preventDefault(); event.stopPropagation();
    }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
    if (hasUnknownModal()) return;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) showQuickActions();
    return;
  }
  const ownedTarget = event.target instanceof Element && event.target.closest(ownedDialogSelector);
  const key = arrowKeyActions[event.key] ?? event.key;
  if (ownedTarget && ['h', 'j', 'k', 'l', 'i', 'o', '[', ']', 'g', 'G', 'H', 'J', 'K', 'L', 'd', 'm', 'n', ',', '.', "'", '/', '=', '-', ';'].includes(key)) {
    onGlobalKeydown(event);
    if (event.defaultPrevented) event.stopPropagation();
    return;
  }
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (event.key === '?') return;
  if (document.querySelector('[data-chart-export-menu]')) return;
  const key = arrowKeyActions[event.key] ?? event.key;
  const awaitingFirstEvent = Date.now() < firstEventDeadline;
  firstEventDeadline = 0;
  if (event.defaultPrevented || event.isComposing) return;
  const leavingTarget = isLeavingDialogTarget(event.target);
  if (event.ctrlKey || event.metaKey || event.altKey || (event.shiftKey && event.key !== 'G' && !shiftedPanActions[event.key]) || (isEditableTarget(event.target) && !leavingTarget)
    || (isSelectionOverlayTarget(event.target) && !leavingTarget) || document.querySelector('.p-select-overlay') || quickDialog.value || pendingDialog || hasUnknownModal()) return;
  if (!active.value) {
    if (!event.shiftKey) libraryView.value?.handleKeydown(event);
    return;
  }
  if (showingOverview.value && key !== 'j' && key !== 'k') { overviewView.value?.handleKeydown(event); return; }
  if (event.key === 'Enter' && selectedTab.value === 0 && occurrence.value) {
    const target = event.target;
    const diagramSurface = target === document || target === document.body || target === document.documentElement
      || (target instanceof Element && (target.matches('.event-content, .event-tablist [role="tab"][aria-selected="true"]')
        || (!!target.closest('.diagram-panel') && !target.closest('button, [role="button"], a'))));
    const link = detailLinks.value.get(occurrence.value.nodeId);
    if (diagramSurface && link?.scenarioId) {
      activateDiagramNode(event, link, () => {}, openDetail);
      return;
    }
  }
  const panAction = event.shiftKey && activeCanvas.value ? shiftedPanActions[event.key] : undefined;
  if (panAction) {
    event.preventDefault();
    if (!event.repeat) executeAction(panAction, event.key);
    return;
  }
  if (event.key === 'g') {
    if (event.repeat || !scenario.value) return;
    event.preventDefault();
    if (awaitingFirstEvent) executeAction('gg');
    else firstEventDeadline = Date.now() + 1000;
    return;
  }
  const action = actions.value.find(action => action.id === key);
  if (action && leavingTarget) event.preventDefault();
  if (action && !action.disabled) {
    event.preventDefault();
    if (action.id === 'i' || action.id === 'o') {
      drillRepeatSkipped[action.id] = event.repeat && !drillRepeatSkipped[action.id];
      if (drillRepeatSkipped[action.id]) return;
    }
    if (!event.repeat || !['G', 'H', 'd', 'm', 'n', ';'].includes(action.id)) executeAction(action.id);
  }
}

function inspectNode(id: string) {
  if (inspectedDiagramId.value === diagram.value?.id && inspectedNodeId.value === id) {
    inspectedNodeId.value = ''; inspectedDiagramId.value = ''; pickedOccurrenceId.value = null;
    return;
  }
  inspectedDiagramId.value = diagram.value?.id ?? '';
  inspectedNodeId.value = id;
  pickedOccurrenceId.value = null;
  const visits = navigation.occurrencesAtNode(id);
  if (visits.length === 1) navigation.selectOccurrence(visits[0]!.id);
}

function onPanKeyup(event: KeyboardEvent) {
  if (event.key === 'Shift') activeCanvas.value?.releasePan();
  else activeCanvas.value?.releasePan(event.key.toUpperCase());
}

function cancelKeyboardPan() { activeCanvas.value?.cancelPan(); domainView.value?.cancelNumberShortcut(); scenarioJump.value?.cancel(); }

function onPanFocus(event: FocusEvent) {
  if (isEditableTarget(event.target) || isSelectionOverlayTarget(event.target) || hasUnknownModal()) cancelKeyboardPan();
}

onMounted(() => {
  routes.start();
  void library.start();
  document.addEventListener('keydown', onOwnedKeydown, true);
  document.addEventListener('keydown', onGlobalKeydown);
  document.addEventListener('keyup', onPanKeyup, true);
  document.addEventListener('focusin', onPanFocus);
  window.addEventListener('blur', cancelKeyboardPan);
});
onUnmounted(() => {
  routes.stop();
  library.stop();
  document.removeEventListener('keydown', onOwnedKeydown, true);
  document.removeEventListener('keydown', onGlobalKeydown);
  document.removeEventListener('keyup', onPanKeyup, true);
  document.removeEventListener('focusin', onPanFocus);
  window.removeEventListener('blur', cancelKeyboardPan);
  pendingDialog = false;
});
</script>

<template>
  <Notifications ref="notifications" :restore="library.restore" />
  <FocusChrome :hidden="focusMode">
  <header class="app-header">
    <div v-if="active" class="header-identity">
    <button type="button" class="mobile-nav-toggle" aria-label="Toggle scenario navigation" aria-controls="scenario-sidebar" :aria-expanded="mobileSidebarOpen" :title="mobileSidebarOpen ? 'Close navigation' : 'Open navigation'" @click="toggleMobileSidebar"><i :class="['pi', mobileSidebarOpen ? 'pi-times' : 'pi-bars']" aria-hidden="true" /></button>
    <h1 class="explanation-heading">
      <button class="brand" aria-label="Lain explanation library" title="Back to explanation library" @click="routes.back">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 12H5m7-7-7 7 7 7" /></svg>
        <span class="explanation-title" :title="active.document.title">{{ active.document.title }}</span>
      </button>
    </h1>
    <ExplanationLinks :key="active.id" :links="active.document.links" :hidden="focusMode" />
    </div>
    <div class="header-actions">
      <span class="connection" role="status"><i :class="['pi', connection === 'connected' ? 'pi-check-circle' : 'pi-circle', connection]" aria-hidden="true" />{{ connectionLabel }}</span>
      <button v-if="active" ref="quickButton" class="quick-actions-trigger" aria-label="Quick actions" title="Quick actions (Ctrl+K)" @click="showQuickActions"><i class="pi pi-search" aria-hidden="true" /><span>Quick actions</span><kbd>Ctrl K</kbd></button>
      <button class="theme-toggle" aria-label="Toggle dark mode" :aria-pressed="dark" :title="dark ? 'Switch to light mode' : 'Switch to dark mode'" @click="toggleTheme"><i :class="['pi', dark ? 'pi-sun' : 'pi-moon']" aria-hidden="true" /></button>
    </div>
  </header>
  </FocusChrome>

  <FocusChrome v-if="active && diagram && scenario && !showingOverview" :hidden="!focusMode">
    <FocusBreadcrumb :explanation="active.document.title" :diagram="diagram.title" :scenario="scenario.title" />
  </FocusChrome>

  <ExplanationLibrary v-if="!active" ref="libraryView" v-model:state="libraryState" :summaries="summaries" :loading="loading" :selecting="selecting" :error="error" :selection-error="selectionError" :remove="library.remove" @deleted="notifications?.deleted($event)" @select="routes.select" @retry="library.retry" />

  <div v-else-if="scenario && diagram && occurrence" :class="['workspace', { 'focus-mode': focusMode }]">
    <div v-if="mobile && mobileSidebarOpen && !focusMode" class="mobile-nav-backdrop" aria-hidden="true" @click="closeMobileSidebar()" />
    <FocusChrome class="focus-sidebar-slot" :hidden="sidebarHidden">
    <aside id="scenario-sidebar" class="sidebar" aria-label="Scenarios">
      <div ref="scenariosRegion" class="sidebar-scroll scenarios-scroll" tabindex="0" role="region" aria-label="Scenario navigation">
      <button type="button" :class="['overview-link', { selected: showingOverview }]" :aria-current="showingOverview ? 'page' : undefined" @click="showOverview"><i class="pi pi-th-large" aria-hidden="true" />Overview</button>
      <div class="path-heading"><span class="eyebrow">{{ active.document.topics?.length ? 'Topics' : 'Scenarios' }}</span></div>
      <nav aria-label="Scenarios">
        <section v-for="group in sections" :key="group.id" :class="['scenario-group', { inactive: showingOverview || !group.scenarios.some(item => item.id === scenarioId) }]" :data-diagram-id="group.kind ? group.id : undefined" :data-topic-id="group.kind ? undefined : group.id">
          <div class="group-heading"><h3>{{ group.title }}</h3><span v-if="group.kind" class="eyebrow">{{ group.kind }}</span><span v-else class="data-count">{{ group.scenarios.length }}</span></div>
          <button v-for="item in group.scenarios" :key="item.id" :class="['scenario-link', { selected: !showingOverview && item.id === scenarioId }]" :aria-current="!showingOverview && item.id === scenarioId ? 'true' : undefined" :aria-describedby="scenarioPreview?.scenarioId === item.id ? scenarioPreview.id : undefined" :data-scenario-title="item.title" @mouseenter="scenarioPreview?.show($event, item)" @mouseleave="scenarioPreview?.leave()" @focus="scenarioPreview?.show($event, item)" @blur="scenarioPreview?.leave()" @click="openScenario(item.id)"><span class="scenario-name">{{ item.title }}</span><ScenarioLabels :labels="item.labels" /></button>
        </section>
      </nav>
      </div>
    </aside>
    </FocusChrome>

    <ScenarioPreview ref="scenarioPreview" :document="active.document" :hidden="focusMode" />
    <ExplanationOverview v-if="showingOverview" :key="active.id" ref="overviewView" v-model:query="overviewQueries[active.id]" :document="active.document" @select="openScenario" @navigate-scenario="executeAction($event > 0 ? 'j' : 'k')" />
    <main v-show="!showingOverview" class="event-view" :inert="showingOverview ? true : undefined" :aria-hidden="showingOverview || undefined">
      <div class="event-content" tabindex="0" role="region" aria-label="Recorded event details">
      <div v-if="selectionError || error" class="event-notices" tabindex="0" role="region" aria-label="Connection errors">
      <div class="inline-error" role="alert">{{ selectionError || error }} <Button label="Retry" size="small" text @click="library.resync" /></div>
      </div>
        <ScenarioContext v-if="active.document.topics?.length || active.document.overview || active.document.comparisons?.length" :document="active.document" :scenario="scenario" @overview="showOverview" @select="openScenario" />
        <StepNavigator :key="`${active.id}/${scenario.id}`" :diagram="diagram" :scenario="scenario" :index="index" :links="detailLinks" @select="navigation.selectOccurrence" @open="openDetail" @navigate-scenario="executeAction($event > 0 ? 'j' : 'k')" />
        <section class="event-tabs" aria-label="Event views">
          <div class="event-tabbar">
          <div class="event-tablist" role="tablist" aria-label="Event views" @keydown="onTabKeydown">
            <button v-for="(tab, position) in tabs" :id="`event-tab-${position}`" :key="tab" role="tab" :aria-selected="selectedTab === position" :aria-controls="`event-panel-${position}`" :tabindex="selectedTab === position ? 0 : -1" @click="selectTab(position)">{{ tab }}</button>
          </div>
          <button ref="dataToggleButton" type="button" class="data-toggle" aria-label="Toggle data inspector" aria-controls="step-inspector" aria-describedby="data-toggle-tooltip" aria-keyshortcuts="n" :aria-expanded="dataOpen" @click="toggleData">
            <i class="pi pi-table" aria-hidden="true" /><span v-if="!focusMode">{{ dataOpen ? 'Hide data' : 'Show data' }}</span>
            <span id="data-toggle-tooltip" class="data-toggle-tooltip" role="tooltip">Toggle data panel <span class="data-toggle-shortcut">N</span></span>
          </button>
          </div>
          <div class="event-workspace">
          <div class="event-panels">
          <div v-if="selectedTab === 0" id="event-panel-0" class="diagram-panel event-tabpanel" role="tabpanel" aria-labelledby="event-tab-0" tabindex="0">
            <ScenarioJump ref="scenarioJump" :diagram="diagram" :scenarios="active.document.scenarios" :scenario-id="scenario.id" :occurrence-id="occurrence.id" @jump="jumpToOccurrence" @focus="diagramView?.focusNode($event)">
            <SequenceView v-if="diagram.kind === 'sequence'" ref="diagramView" :state-key="`${canvasStateKey}/diagram`" :diagram="diagram" :scenario="scenario" :current-occurrence-id="occurrence.id" :links="detailLinks" @inspect="inspectNode" @open="openDetail" />
            <GraphView v-else-if="graph" ref="diagramView" :key="diagram.id" :state-key="`${canvasStateKey}/diagram`" :layout="graph" :title="diagram.title" :scenario-title="scenario.title" :current-node-id="occurrence.nodeId" :current-occurrence-id="`${scenario.id}/${occurrence.id}`" :visited-node-ids="visitedNodes" :visited-edge-ids="visitedEdges" :scenario-node-ids="scenarioNodes" :scenario-edge-ids="scenarioEdges" :links="detailLinks" interactive @select="inspectNode" @open="openDetail" />
            </ScenarioJump>
            <div v-if="inspectedNode" class="node-inspector"><h3>{{ inspectedNode.label }}</h3><p class="muted">Entities: {{ inspectedNode.entityIds.map(id => active?.document.domain.entities.find(entity => entity.id === id)?.label).join(', ') || 'None linked' }}</p>
              <p v-if="!nodeOccurrences.length" class="offpath-note">Off this scenario’s path. You can inspect this node, but it has no captured occurrence here. The current event stays unchanged.</p>
              <div v-else-if="nodeOccurrences.length > 1" class="occurrence-picker"><p>This node appears {{ nodeOccurrences.length }} times. Choose an occurrence; each visit has its own snapshots.</p><Select v-model="pickedOccurrenceId" :options="nodeOccurrences" option-label="label" option-value="id" placeholder="Choose a recorded occurrence" aria-label="Recorded occurrence" /><Button label="Go to occurrence" :disabled="!pickedOccurrenceId" @click="pickedOccurrenceId && navigation.selectOccurrence(pickedOccurrenceId)" /></div>
              <p v-else class="muted">Showing this node’s recorded occurrence.</p>
            </div>
          </div>
          <div v-if="selectedTab === 1" id="event-panel-1" class="domain-panel event-tabpanel" role="tabpanel" aria-labelledby="event-tab-1" tabindex="0">
            <DomainView ref="domainView" :state-key="`${canvasStateKey}/domain`" :domain="active.document.domain" :diagram="diagram" :scenario="scenario" :occurrence="occurrence" :selected-entity-id="inspectedEntityId" @select="id => inspectedEntityId = id" @inspect="inspectProperty" />
            <div v-if="inspectedEntity" class="node-inspector"><h3>{{ inspectedEntity.label }}</h3><p class="eyebrow">{{ inspectedEntity.id }}</p><dl class="entity-attributes"><template v-for="attribute in inspectedEntity.attributes" :key="attribute.id"><dt>{{ attribute.label }}</dt><dd>{{ attribute.id }}</dd></template></dl>
              <section v-if="inspectedEntity.methods?.length" class="entity-methods" aria-label="Entity methods">
                <h4>Methods</h4>
                <div v-for="method in inspectedEntity.methods" :key="method.id" class="entity-method">
                  <code>{{ method.signature }}</code><small class="muted">{{ method.id }}</small><p>{{ method.description }}</p>
                </div>
              </section>
            </div>
          </div>
          </div>
          <div :class="['inspector-shell', { open: dataOpen }]" :inert="dataOpen ? undefined : true" :aria-hidden="!dataOpen">
            <div class="inspector-slot"><StepInspector ref="dataInspector" :document="active.document" :occurrence="occurrence" :node-label="currentNode?.label ?? occurrence.nodeId" :position="index + 1" :selected-entity-id="inspectedEntityId" @close="toggleData" @select="selectDataEntity" /></div>
          </div>
          </div>
        </section>
      </div>
      <FocusChrome :hidden="focusMode">
      <footer class="event-controls"><Button label="Previous event" icon="pi pi-arrow-left" severity="secondary" outlined :disabled="index === 0" @click="navigation.step(-1)" /><span class="eyebrow"><span aria-hidden="true">❤️</span> Focus<span class="focus-message-detail"> is your superpower</span></span><Button v-if="index < scenario.occurrences.length - 1" label="Next event" icon="pi pi-arrow-right" icon-pos="right" @click="navigation.step(1)" /><Button v-else label="Replay scenario" icon="pi pi-replay" @click="navigation.selectOccurrence(scenario.occurrences[0]!.id)" /></footer>
      </FocusChrome>
    </main>
  </div>

  <QuickActionsDialog ref="quickActionsDialog" v-model:visible="quickDialog" :close-on-escape="false" :actions="actions" @execute="executeAction" @after-hide="afterDialogHide" />
</template>

<style scoped>
.entity-methods{border-top:1px solid var(--line);margin-top:16px;padding-top:16px}
.entity-methods h4{margin:0 0 12px}
.entity-method{margin-bottom:16px;overflow-wrap:anywhere}
.entity-method code{white-space:pre-wrap;font-size:.85rem}
.entity-method small{display:block;margin-top:4px}
.entity-method p{margin:8px 0 0;font-size:.85rem;white-space:pre-wrap}
</style>
