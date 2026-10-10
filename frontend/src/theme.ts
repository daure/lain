import { ref } from 'vue';

const storageKey = 'lain-theme';

function storageUnavailable(error: unknown) {
  return error instanceof DOMException && (error.name === 'SecurityError' || error.name === 'QuotaExceededError');
}

function applyTheme(dark: boolean) {
  document.documentElement.classList.toggle('app-dark', dark);
}

export function initializeTheme() {
  let dark = false;
  try {
    dark = localStorage.getItem(storageKey) === 'dark';
  } catch (error) {
    if (!storageUnavailable(error)) throw error;
  }
  applyTheme(dark);
  return dark;
}

export function useTheme() {
  const dark = ref(initializeTheme());
  function toggleTheme() {
    dark.value = !dark.value;
    applyTheme(dark.value);
    try {
      localStorage.setItem(storageKey, dark.value ? 'dark' : 'light');
    } catch (error) {
      if (!storageUnavailable(error)) throw error;
    }
  }
  return { dark, toggleTheme };
}
