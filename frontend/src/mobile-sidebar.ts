import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';

export function useMobileSidebar(focusMode: Ref<boolean>) {
  const mobile = ref(false);
  const open = ref(false);
  let media: MediaQueryList | undefined;

  function close(restoreFocus = true) {
    if (!open.value) return;
    open.value = false;
    if (restoreFocus) void nextTick(() => document.querySelector<HTMLButtonElement>('.mobile-nav-toggle')?.focus({ preventScroll: true }));
  }

  function updateViewport() {
    mobile.value = media?.matches ?? false;
    close(false);
  }

  function toggle() {
    if (open.value) { close(); return; }
    open.value = true;
    void nextTick(() => document.querySelector<HTMLButtonElement>('.sidebar .overview-link')?.focus({ preventScroll: true }));
  }

  function onFocus(event: FocusEvent) {
    if (event.target instanceof Element && !event.target.closest('.sidebar, .mobile-nav-toggle, .scenario-preview')) close(false);
  }

  watch(focusMode, () => close(false));
  onMounted(() => {
    media = window.matchMedia('(max-width: 700px)');
    updateViewport();
    media.addEventListener?.('change', updateViewport);
    document.addEventListener('focusin', onFocus);
  });
  onUnmounted(() => {
    media?.removeEventListener?.('change', updateViewport);
    document.removeEventListener('focusin', onFocus);
  });

  return { mobile, open, close, toggle };
}
