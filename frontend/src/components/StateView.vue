<script setup lang="ts">
import { computed } from 'vue';
import type { Explanation, Occurrence } from '../model';
import { compareInstances, compareLinks, formatValue } from '../snapshots';

const props = defineProps<{ document: Explanation; occurrence: Occurrence }>();
const instances = computed(() => compareInstances(props.document.domain.entities, props.occurrence.before, props.occurrence.after));
const links = computed(() => compareLinks(props.document, props.occurrence.before, props.occurrence.after));
</script>

<template>
  <section class="state-panel" tabindex="0" aria-labelledby="state-title">
    <p class="eyebrow">State / values / data</p>
    <h2 id="state-title">At this event</h2>
    <p class="muted state-caption">Before → After · Complete captured snapshots</p>
    <p v-if="!instances.length" class="muted">No instances captured at this event.</p>
    <article v-for="instance in instances" :key="instance.id" class="instance">
      <div class="instance-heading">
        <h3>{{ instance.label }} <span class="instance-id">{{ instance.id }}</span></h3>
        <span :class="['badge', instance.change]">{{ instance.change }}</span>
      </div>
      <p v-if="!instance.attributes.length" class="muted">No attributes defined.</p>
      <div v-for="attribute in instance.attributes" :key="attribute.id" :class="['value-row', attribute.change]">
        <div class="attribute-label">{{ attribute.label }} <span class="value-status">{{ attribute.change }}</span></div>
        <div class="values">
          <pre :class="attribute.before.kind">{{ formatValue(attribute.before) }}</pre>
          <span class="value-arrow" :aria-label="attribute.change">{{ attribute.change === 'unchanged' ? '=' : '→' }}</span>
          <pre :class="attribute.after.kind">{{ formatValue(attribute.after) }}</pre>
        </div>
      </div>
    </article>
    <section v-if="links.length" class="links">
      <h3>Relationships</h3>
      <div v-for="link in links" :key="link.id" class="link-row">
        <span>{{ link.label }}</span><span :class="['badge', link.change]">{{ link.change }}</span>
      </div>
    </section>
    <p class="snapshot-note">Uncaptured means the attribute was not recorded. Absent means the instance does not exist in that snapshot. <code>null</code> is a captured value. Each snapshot belongs to this occurrence, including revisits.</p>
  </section>
</template>
