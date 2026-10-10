import { createApp } from 'vue';
import PrimeVue from 'primevue/config';
import ToastService from 'primevue/toastservice';
import Aura from '@primeuix/themes/aura';
import { definePreset } from '@primeuix/themes';
import 'primeicons/primeicons.css';
import './style.css';
import App from './App.vue';
import { initializeTheme } from './theme';

const theme = definePreset(Aura, {
  semantic: {
    primary: { 50: '{blue.50}', 100: '{blue.100}', 200: '{blue.200}', 300: '{blue.300}', 400: '{blue.400}', 500: '{blue.500}', 600: '{blue.600}', 700: '{blue.700}', 800: '{blue.800}', 900: '{blue.900}', 950: '{blue.950}' },
    colorScheme: {
      dark: {
        primary: { color: '{zinc.50}', contrastColor: '{zinc.950}', hoverColor: '{zinc.200}', activeColor: '{zinc.300}' },
        highlight: { background: '{zinc.800}', focusBackground: '{zinc.700}', color: '{zinc.50}', focusColor: '{zinc.50}' },
      },
    },
  },
});

initializeTheme();
createApp(App).use(PrimeVue, { theme: { preset: theme, options: { darkModeSelector: '.app-dark' } } }).use(ToastService).mount('#app');
