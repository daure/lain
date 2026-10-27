// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import DomainView from '../src/components/DomainView.vue';
import { domainLayout } from '../src/domain';
import type { Domain, Explanation, Occurrence, Scenario } from '../src/model';

function pathCommands(path: string) {
  return [...path.matchAll(/([MLQ])([^MLQ]+)/g)].map(match => {
    const values = match[2]!.trim().split(/[ ,]+/).map(Number);
    const points = [];
    for (let index = 0; index < values.length; index += 2) points.push({ x: values[index]!, y: values[index + 1]! });
    return { kind: match[1]!, points };
  });
}

it.each([
  ['zeroOrOne', 'zero', 'M8,-8 V8', 'zero or one (0..1)'],
  ['exactlyOne', 'one', 'M8,-8 V8', 'exactly one (1..1)'],
  ['zeroOrMore', 'zero', 'M18,0 L0,-8 M18,0 L0,0 M18,0 L0,8', 'zero or more (0..*)'],
  ['oneOrMore', 'one', 'M18,0 L0,-8 M18,0 L0,0 M18,0 L0,8', 'one or more (1..*)'],
  ['one', 'zero', 'M8,-8 V8', 'zero or one (0..1)'],
  ['many', 'zero', 'M18,0 L0,-8 M18,0 L0,0 M18,0 L0,8', 'zero or more (0..*)'],
] as const)('renders both bounds for %s on both relationship endpoints', (cardinality, minimum, maximumPath, label) => {
  const authored = structuredClone(fixture) as Explanation;
  authored.domain!.relationships = JSON.parse(JSON.stringify([{ ...authored.domain!.relationships[0]!, sourceCardinality: cardinality, targetCardinality: cardinality }]));
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render: () => h(DomainView, { domain: authored.domain!, diagram: authored.diagrams[0]!, scenario: authored.scenarios[0]!, selectedEntityId: '' }) });
  app.mount(root);
  try {
    const endpoints = root.querySelectorAll('.domain-cardinality');
    expect(endpoints).toHaveLength(2);
    for (const endpoint of endpoints) {
      expect(endpoint.getAttribute('data-cardinality')).toBe(cardinality === 'one' ? 'zeroOrOne' : cardinality === 'many' ? 'zeroOrMore' : cardinality);
      expect(endpoint.getAttribute('data-minimum')).toBe(minimum);
      expect(endpoint.querySelector('title')!.textContent).toBe(label);
      expect(endpoint.querySelector('.domain-cardinality-maximum')!.getAttribute('d')).toBe(maximumPath);
      if (minimum === 'zero') {
        expect(endpoint.querySelector('.domain-cardinality-zero')!.getAttribute('r')).toBe('5');
        expect(endpoint.querySelector('.domain-cardinality-required')).toBeNull();
      } else {
        expect(endpoint.querySelector('.domain-cardinality-required')!.getAttribute('d')).toBe('M26,-8 V8');
        expect(endpoint.querySelector('.domain-cardinality-zero')).toBeNull();
      }
    }
    expect(authored.domain!.relationships[0]!.sourceCardinality).toBe(cardinality);
    expect(root.querySelectorAll('.domain-entity')).toHaveLength(authored.domain!.entities.length);
  } finally { app.unmount(); root.remove(); }
});

it('shows neighboring After counts with initial Before and final After counts at scenario boundaries', async () => {
  const domain: Domain = { entities: [{ id: 'item', label: 'Item', attributes: [] }], relationships: [] };
  const empty = { instances: [], links: [] };
  const populated = { instances: ['a', 'b'].map(id => ({ id, entityId: 'item', values: {} })), links: [] };
  const visits: Occurrence[] = [
    { id: 'empty', nodeId: 'work', incomingEdgeId: null, trigger: null, narration: '', before: populated, after: empty },
    { id: 'created', nodeId: 'work', incomingEdgeId: 'again', trigger: null, narration: '', before: empty, after: populated },
    { id: 'removed', nodeId: 'work', incomingEdgeId: 'again', trigger: null, narration: '', before: populated, after: empty },
  ];
  const scenario = ref<Scenario>({ id: 'recording', title: 'Recording', diagramId: 'flow', occurrences: visits });
  const occurrence = ref(visits[0]!);
  const diagram = { id: 'flow', title: 'Flow', kind: 'flow' as const, nodes: [{ id: 'work', label: 'Work', entityIds: ['item'] }],
    edges: [{ id: 'again', sourceNodeId: 'work', targetNodeId: 'work', label: '' }] };
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render: () => h(DomainView, { domain, diagram, scenario: scenario.value, occurrence: occurrence.value, selectedEntityId: '' }) });
  app.mount(root);
  try {
    const count = () => root.querySelector('.domain-count-values')!.textContent;
    expect(count()).toBe('2 · 0 · 2');
    expect(root.querySelector('.domain-instance-count')!.getAttribute('aria-label')).toContain('Scenario start (Before): 2');
    occurrence.value = visits[1]!;
    await nextTick();
    await vi.waitFor(() => expect(count()).toBe('0 · 2 · 0'));
    expect(root.querySelector('.domain-count-current')!.textContent).toBe('2');
    expect(root.querySelector('.domain-instance-count')!.getAttribute('aria-label')).toContain('Previous: 0 · Current (After): 2 · Next: 0');
    occurrence.value = visits[0]!;
    await nextTick();
    await vi.waitFor(() => expect(count()).toBe('2 · 0 · 2'));
    occurrence.value = visits[1]!;
    await nextTick();
    occurrence.value = visits[2]!;
    await nextTick();
    await vi.waitFor(() => expect(count()).toBe('2 · 0 · 0'));
    expect(root.querySelector('.domain-instance-count')!.getAttribute('aria-label')).toContain('Scenario end (After): 0');
    scenario.value = { id: 'single', title: 'Single step', diagramId: 'flow', occurrences: [visits[1]!] };
    occurrence.value = visits[1]!;
    await nextTick();
    expect(count()).toBe('0 · 2 · 2');
  } finally { app.unmount(); root.remove(); }
});

it('shows scenario-wide domain usage from visited nodes and both snapshots while keeping unrelated definitions inspectable', async () => {
  const documentFixture = structuredClone(fixture) as Explanation;
  for (const id of ['node-only', 'snapshot-only', 'other-branch', 'unused']) {
    documentFixture.domain!.entities.push({ id, label: id, attributes: [] });
  }
  const diagram = documentFixture.diagrams[0]!;
  diagram.nodes.find(node => node.id === 'fulfill')!.entityIds.push('node-only');
  diagram.nodes.find(node => node.id === 'decline')!.entityIds.push('other-branch');
  documentFixture.domain!.relationships.push({ id: 'unrecorded', label: 'Unrecorded association', sourceEntityId: 'order', targetEntityId: 'payment', sourceCardinality: 'zeroOrMore', targetCardinality: 'zeroOrOne' });
  const success = documentFixture.scenarios[0]!;
  success.occurrences.at(-1)!.before.instances.push({ id: 'snapshot-instance', entityId: 'snapshot-only', values: {} });
  const selectedScenario = ref(success);
  const selectedEntityId = ref('');
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render: () => h(DomainView, { domain: documentFixture.domain!, diagram,
    scenario: selectedScenario.value, selectedEntityId: selectedEntityId.value, onSelect: id => { selectedEntityId.value = id; } }) });
  app.mount(root);
  try {
    const entity = (id: string) => root.querySelector<SVGGElement>(`[data-entity-id="${id}"]`)!;
    const geometry = () => [...root.querySelectorAll('.domain-entity')].map(node => node.getAttribute('transform'));
    const initialGeometry = geometry();
    expect(root.querySelectorAll('.domain-entity')).toHaveLength(documentFixture.domain!.entities.length);
    expect(entity('fulfillment').classList.contains('unrelated')).toBe(false);
    expect(entity('node-only').classList.contains('unrelated')).toBe(false);
    expect(entity('snapshot-only').classList.contains('unrelated')).toBe(false);
    expect(entity('other-branch').classList.contains('unrelated')).toBe(true);
    expect(entity('unused').getAttribute('aria-label')).toBe(`unused · Outside New payment queues fulfillment · Shortcut ${entity('unused').dataset.shortcutNumber}`);
    expect(root.querySelector('[data-relationship-id="order-fulfillments"]')!.classList.contains('unrelated')).toBe(false);
    expect(root.querySelector('[data-relationship-id="unrecorded"]')!.classList.contains('unrelated')).toBe(true);
    const cardinalities = root.querySelectorAll('[data-relationship-id="order-payments"] .domain-cardinality');
    expect([...cardinalities].map(node => node.getAttribute('data-cardinality'))).toEqual(['zeroOrOne', 'zeroOrMore']);
    expect(root.querySelectorAll('[data-entity-id="shipment"] .domain-property')).toHaveLength(9);
    entity('unused').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(selectedEntityId.value).toBe('unused');
    expect(entity('unused').getAttribute('aria-pressed')).toBe('true');
    selectedScenario.value = documentFixture.scenarios[2]!;
    await nextTick();
    expect(entity('other-branch').classList.contains('unrelated')).toBe(false);
    expect(entity('node-only').classList.contains('unrelated')).toBe(true);
    expect(entity('snapshot-only').classList.contains('unrelated')).toBe(true);
    expect(geometry()).toEqual(initialGeometry);
  } finally { app.unmount(); root.remove(); }
});

it('lays out self-links, parallel relationships, and wrapped definitions with rounded orthogonal connectors', () => {
  const domain: Domain = {
    entities: [
      { id: 'a', label: 'A very long entity title that spans several header lines', attributes: [{ id: 'longAttributeIdentifierWithMoreThanSixteenCharacters', label: 'An attribute label that must wrap across several rows' }] },
      { id: 'b', label: 'B', attributes: [], methods: [
        { id: 'calculate', signature: 'calculateTotalForAllLineItems(currency: string, discounts: Discount[]): Decimal', description: 'Calculate a total for the complete recorded order using the declared currency and discounts.' },
        { id: 'clear', signature: 'clear(): void', description: '' },
      ] },
    ],
    relationships: [
      { id: 'self', label: 'references itself', sourceEntityId: 'a', targetEntityId: 'a', sourceCardinality: 'zeroOrOne', targetCardinality: 'zeroOrMore' },
      { id: 'first', label: 'first relationship', sourceEntityId: 'a', targetEntityId: 'b', sourceCardinality: 'exactlyOne', targetCardinality: 'zeroOrOne' },
      { id: 'second', label: 'second relationship', sourceEntityId: 'a', targetEntityId: 'b', sourceCardinality: 'oneOrMore', targetCardinality: 'zeroOrMore' },
    ],
  };
  const layout = domainLayout(domain);
  expect(layout.entities[0]!.titleLines.length).toBeGreaterThan(1);
  expect(layout.entities[0]!.rows[0]!.height).toBeGreaterThan(32);
  const methodsEntity = layout.entities[1]!;
  expect(methodsEntity.methodsY).toBe(methodsEntity.headerHeight + 32);
  expect(methodsEntity.methods.map(method => method.id)).toEqual(['calculate', 'clear']);
  expect(methodsEntity.methods[0]!.signatureLines.length).toBeGreaterThan(1);
  expect(methodsEntity.methods[1]!.y).toBe(methodsEntity.methods[0]!.y + methodsEntity.methods[0]!.height);
  expect(methodsEntity.height).toBe(methodsEntity.methods.at(-1)!.y + methodsEntity.methods.at(-1)!.height);
  expect(new Set(layout.relationships.map(edge => edge.path)).size).toBe(3);
  for (const edge of layout.relationships) {
    const commands = pathCommands(edge.path);
    expect(commands[0]!.points[0]).toEqual({ x: edge.sourceEnd.x, y: edge.sourceEnd.y });
    expect(commands.at(-1)!.points[0]).toEqual({ x: edge.targetEnd.x, y: edge.targetEnd.y });
    let previous = commands[0]!.points[0]!;
    for (const command of commands) {
      for (const point of command.points) {
        expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(layout.width);
        expect(point.y).toBeLessThanOrEqual(layout.height);
        expect(point.x === previous.x || point.y === previous.y).toBe(true);
        if (command.kind === 'Q') expect(Math.hypot(point.x - previous.x, point.y - previous.y)).toBeLessThanOrEqual(8);
        previous = point;
      }
    }
  }
  expect(domainLayout({ entities: [], relationships: [] }).entities).toEqual([]);
});

it('routes ungrouped attribute-only parcel and payment associations with one rounded elbow and labels above their horizontal lanes', () => {
  const domain = structuredClone(fixture.domain) as Domain;
  delete domain.groups;
  domain.entities = domain.entities.filter(entity => entity.id !== 'gateway' && entity.id !== 'callback-dto');
  domain.relationships = domain.relationships.filter(edge => domain.entities.some(entity => entity.id === edge.sourceEntityId)
    && domain.entities.some(entity => entity.id === edge.targetEntityId));
  for (const entity of domain.entities) delete entity.methods;
  const layout = domainLayout(domain);
  const edges = new Map(layout.relationships.map(edge => [edge.id, edge]));
  for (const id of ['order-shipments', 'order-payments']) {
    const edge = edges.get(id)!;
    const commands = pathCommands(edge.path);
    expect(commands.map(command => command.kind)).toEqual(['M', 'L', 'Q', 'L']);
    const start = commands[0]!.points[0]!;
    const corner = commands[2]!.points[0]!;
    const end = commands[3]!.points[0]!;
    expect(start.x).toBe(corner.x);
    expect(corner.y).toBe(end.y);
    expect(edge.y).toBeLessThan(corner.y);
  }
  const packing = edges.get('fulfillment-shipment')!;
  expect(packing.sourceEnd.y).toBe(packing.targetEnd.y);
  expect(packing.path.split(' ')).toHaveLength(2);
  expect(packing.y).toBeLessThan(packing.sourceEnd.y);
});

it.each([true, false])('keeps nested domain frames compact and separate with headings that fit their available width (methods: %s)', methods => {
  const domain = structuredClone(fixture.domain) as Domain;
  if (!methods) for (const entity of domain.entities) delete entity.methods;
  const layout = domainLayout(domain);
  const frames = new Map(layout.groups.map(group => [group.id, group]));
  const bounds = (item: { x: number; y: number; width: number; height: number }) => ({
    left: item.x - item.width / 2, right: item.x + item.width / 2,
    top: item.y - item.height / 2, bottom: item.y + item.height / 2,
  });
  const commerce = bounds(frames.get('commerce')!);
  const external = bounds(frames.get('external-payment-system')!);
  const payments = bounds(frames.get('payments')!);
  const fulfillment = bounds(frames.get('fulfillment-domain')!);
  expect(commerce.top - external.bottom).toBeCloseTo(42);
  expect(fulfillment.top - payments.bottom).toBeCloseTo(56);
  const order = bounds(layout.entities.find(entity => entity.id === 'order')!);
  expect(payments.left - order.right).toBeGreaterThanOrEqual(24);
  expect(payments.left - order.right).toBeLessThanOrEqual(160);
  expect(frames.get('external-payment-system')!.lines).toEqual(['External system: payment gateway']);
  for (const edge of layout.relationships) {
    const commands = pathCommands(edge.path);
    expect(commands[0]!.points[0]).toEqual({ x: edge.sourceEnd.x, y: edge.sourceEnd.y });
    expect(commands.at(-1)!.points.at(-1)).toEqual({ x: edge.targetEnd.x, y: edge.targetEnd.y });
    for (const [end, id] of [[edge.sourceEnd, edge.sourceEntityId], [edge.targetEnd, edge.targetEntityId]] as const) {
      const table = bounds(layout.entities.find(entity => entity.id === id)!);
      expect(end.x === table.left || end.x === table.right || end.y === table.top || end.y === table.bottom).toBe(true);
      expect(end.x).toBeGreaterThanOrEqual(table.left);
      expect(end.x).toBeLessThanOrEqual(table.right);
      expect(end.y).toBeGreaterThanOrEqual(table.top);
      expect(end.y).toBeLessThanOrEqual(table.bottom);
    }
  }
  for (const group of domain.groups!) {
    const frame = frames.get(group.id)!;
    const outer = bounds(frame);
    for (const child of [...layout.entities.filter(entity => group.entityIds.includes(entity.id)),
      ...layout.groups.filter(child => domain.groups!.find(authored => authored.id === child.id)?.parentGroupId === group.id)]) {
      const inner = bounds(child);
      expect(inner.left - outer.left).toBeGreaterThanOrEqual(24);
      expect(outer.right - inner.right).toBeGreaterThanOrEqual(24);
      expect(inner.top - outer.top - frame.headerHeight).toBeGreaterThanOrEqual(24);
      expect(outer.bottom - inner.bottom).toBeGreaterThanOrEqual(24);
    }
  }
});

it('reserves sibling frame separation through eight levels of nesting and wrapped headings', () => {
  const domain: Domain = {
    entities: ['a', 'b'].map(id => ({ id, label: id, attributes: [] })),
    relationships: [],
    groups: ['a', 'b'].flatMap(id => Array.from({ length: 8 }, (_, depth) => ({
      id: `${id}-${depth}`, label: `A long container heading for ${id} that wraps above its nested contents`,
      entityIds: depth === 7 ? [id] : [], parentGroupId: depth ? `${id}-${depth - 1}` : undefined,
    }))),
  };
  const layout = domainLayout(domain);
  const roots = layout.groups.filter(group => group.id === 'a-0' || group.id === 'b-0').sort((a, b) => a.y - b.y);
  expect(roots[1]!.y - roots[1]!.height / 2 - (roots[0]!.y + roots[0]!.height / 2)).toBeCloseTo(42);
  expect(layout.entities.map(entity => entity.shortcutNumber).sort()).toEqual([1, 2]);
  for (const group of layout.groups) {
    expect(Number.isFinite(group.x) && Number.isFinite(group.y)).toBe(true);
    expect(group.y - group.height / 2).toBeGreaterThanOrEqual(32);
    expect(group.y + group.height / 2).toBeLessThanOrEqual(layout.height - 32);
  }
});

it('correlates each recorded visit with property differences and explicit calls without moving the shared tables', async () => {
  const domain: Domain = { entities: [{ id: 'item', label: 'Item', attributes: [
    { id: 'status', label: 'Status' }, { id: 'optional', label: 'Optional' }, { id: 'payload', label: 'Payload' },
  ], methods: [{ id: 'status', signature: 'status(): void', description: '<script>untrusted</script>' }] }], relationships: [] };
  const first: Occurrence = { id: 'first', nodeId: 'work', incomingEdgeId: null, trigger: null, narration: '',
    before: { instances: [
      { id: 'a', entityId: 'item', values: { status: 'pending', payload: { a: 1, b: 2 } } },
      { id: 'removed', entityId: 'item', values: { status: 'old' } },
    ], links: [] },
    after: { instances: [
      { id: 'a', entityId: 'item', values: { status: 'done', optional: null, payload: { b: 2, a: 1 } } },
      { id: 'created', entityId: 'item', values: { status: 'new' } },
    ], links: [] },
    methodCalls: [{ entityId: 'item', methodId: 'status', instanceId: 'a' }, { entityId: 'item', methodId: 'status' }] };
  const revisit: Occurrence = { ...first, id: 'revisit', incomingEdgeId: 'again',
    before: { instances: [{ id: 'a', entityId: 'item', values: { status: 'externally-updated' } }], links: [] },
    after: { instances: [{ id: 'a', entityId: 'item', values: { status: 'externally-updated' } }], links: [] } };
  const idle: Occurrence = { ...revisit, id: 'idle', methodCalls: undefined, trigger: 'status()' };
  const scenario = { id: 'recording', title: 'Recording', diagramId: 'flow', occurrences: [first, revisit, idle] };
  const diagram = { id: 'flow', title: 'Flow', kind: 'flow' as const, nodes: [{ id: 'work', label: 'Work', entityIds: [] }],
    edges: [{ id: 'again', sourceNodeId: 'work', targetNodeId: 'work', label: '' }] };
  const occurrence = ref(first);
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render: () => h(DomainView, { domain, diagram, scenario, occurrence: occurrence.value, selectedEntityId: '' }) });
  app.mount(root);
  try {
    const geometry = root.querySelector('.domain-entity')!.getAttribute('transform');
    expect(root.querySelector('.domain-entity')!.classList.contains('unrelated')).toBe(false);
    expect(root.querySelector('[data-attribute-id="status"]')!.classList.contains('changed')).toBe(true);
    expect(root.querySelector('[data-attribute-id="optional"] title')!.textContent).toContain('a · Capture changed · Uncaptured → null');
    expect(root.querySelector('[data-attribute-id="payload"] title')!.textContent).not.toContain('a ·');
    expect(root.querySelector('[data-attribute-id="status"] title')!.textContent).toContain('removed · removed · "old" → Absent');
    expect(root.querySelector('[data-attribute-id="status"] title')!.textContent).toContain('created · created · Absent → "new"');
    expect(root.querySelector('.domain-method.called title')!.textContent).toContain('Called 2× in this step · a · Receiver not captured');
    expect(root.querySelector('.domain-count-values')!.textContent).toBe('2 · 2 · 1');
    expect(root.querySelectorAll('script')).toHaveLength(0);
    occurrence.value = revisit;
    await nextTick();
    expect(root.querySelectorAll('.domain-property.changed, .domain-property.created, .domain-property.removed')).toHaveLength(0);
    expect(root.querySelector('.domain-method.called')).not.toBeNull();
    await vi.waitFor(() => expect(root.querySelector('.domain-count-values')!.textContent).toBe('2 · 1 · 1'));
    occurrence.value = idle;
    await nextTick();
    expect(root.querySelector('.domain-method.called')).toBeNull();
    await vi.waitFor(() => expect(root.querySelector('.domain-count-values')!.textContent).toBe('1 · 1 · 1'));
    expect(root.querySelector('.domain-entity')!.getAttribute('transform')).toBe(geometry);
  } finally { app.unmount(); root.remove(); }
});
