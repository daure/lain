<script setup lang="ts">
defineProps<{ hidden: boolean }>();
</script>

<template>
  <div v-show="!hidden" class="focus-chrome" :inert="hidden ? true : undefined" :aria-hidden="hidden ? 'true' : undefined">
    <div class="focus-chrome-inner"><slot /></div>
  </div>
</template>

<style scoped>
.focus-chrome{display:grid;grid-template-rows:minmax(0,1fr);flex-shrink:0;min-width:0;min-height:0;overflow:hidden}
.focus-chrome-inner{display:flex;flex-direction:column;min-width:0;min-height:0}
</style>
