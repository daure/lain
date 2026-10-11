// @vitest-environment jsdom
import { createApp, h, nextTick, ref } from 'vue';
import { expect, it } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import DomainView from '../src/components/DomainView.vue';
import { domainLayout } from '../src/domain';
import type { Explanation } from '../src/model';

function pathCommands(path: string) {
  return [...path.matchAll(/([MLQ])([^MLQ]+)/g)].map(match => {
    const values = match[2]!.trim().split(/[ ,]+/).map(Number);
    const points = [];
    for (let index = 0; index < values.length; index += 2) points.push({ x: values[index]!, y: values[index + 1]! });
    return { kind: match[1]!, points };
  });
}

it('shows scenario-wide domain usage from visited nodes and both snapshots while keeping unrelated definitions inspectable', async () => {
  const documentFixture = structuredClone(fixture) as Explanation;
  for (const id of ['node-only', 'snapshot-only', 'other-branch', 'unused']) {
    documentFixture.domain.entities.push({ id, label: id, attributes: [] });
  }
  const diagram = documentFixture.diagrams[0]!;
  diagram.nodes.find(node => node.id === 'fulfill')!.entityIds.push('node-only');
  diagram.nodes.find(node => node.id === 'decline')!.entityIds.push('other-branch');
  documentFixture.domain.relationships.push({ id: 'unrecorded', label: 'Unrecorded association', sourceEntityId: 'order', targetEntityId: 'payment', sourceCardinality: 'many', targetCardinality: 'one' });
  const success = documentFixture.scenarios[0]!;
  success.occurrences.at(-1)!.before.instances.push({ id: 'snapshot-instance', entityId: 'snapshot-only', values: {} });
  const selectedScenario = ref(success);
  const selectedEntityId = ref('');
  const root = document.createElement('div');
  document.body.append(root);
  const app = createApp({ render: () => h(DomainView, { domain: documentFixture.domain, diagram,
    scenario: selectedScenario.value, selectedEntityId: selectedEntityId.value, onSelect: id => { selectedEntityId.value = id; } }) });
  app.mount(root);
  try {
    const entity = (id: string) => root.querySelector<SVGGElement>(`[data-entity-id="${id}"]`)!;
    const geometry = () => [...root.querySelectorAll('.domain-entity')].map(node => node.getAttribute('transform'));
    const initialGeometry = geometry();
    expect(root.querySelectorAll('.domain-entity')).toHaveLength(documentFixture.domain.entities.length);
    expect(entity('fulfillment').classList.contains('unrelated')).toBe(false);
    expect(entity('node-only').classList.contains('unrelated')).toBe(false);
    expect(entity('snapshot-only').classList.contains('unrelated')).toBe(false);
    expect(entity('other-branch').classList.contains('unrelated')).toBe(true);
    expect(entity('unused').getAttribute('aria-label')).toBe(`unused · Outside Successful callback · Shortcut ${entity('unused').dataset.shortcutNumber}`);
    expect(root.querySelector('[data-relationship-id="order-fulfillments"]')!.classList.contains('unrelated')).toBe(false);
    expect(root.querySelector('[data-relationship-id="unrecorded"]')!.classList.contains('unrelated')).toBe(true);
    const cardinalities = root.querySelectorAll('[data-relationship-id="order-payments"] .domain-cardinality');
    expect([...cardinalities].map(node => node.getAttribute('data-cardinality'))).toEqual(['one', 'many']);
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
  const domain: Explanation['domain'] = {
    entities: [
      { id: 'a', label: 'A very long entity title that spans several header lines', attributes: [{ id: 'longAttributeIdentifierWithMoreThanSixteenCharacters', label: 'An attribute label that must wrap across several rows' }] },
      { id: 'b', label: 'B', attributes: [], methods: [
        { id: 'calculate', signature: 'calculateTotalForAllLineItems(currency: string, discounts: Discount[]): Decimal', description: 'Calculate a total for the complete recorded order using the declared currency and discounts.' },
        { id: 'clear', signature: 'clear(): void', description: '' },
      ] },
    ],
    relationships: [
      { id: 'self', label: 'references itself', sourceEntityId: 'a', targetEntityId: 'a', sourceCardinality: 'one', targetCardinality: 'many' },
      { id: 'first', label: 'first relationship', sourceEntityId: 'a', targetEntityId: 'b', sourceCardinality: 'one', targetCardinality: 'one' },
      { id: 'second', label: 'second relationship', sourceEntityId: 'a', targetEntityId: 'b', sourceCardinality: 'many', targetCardinality: 'many' },
    ],
  };
  const layout = domainLayout(domain);
  expect(layout.entities[0]!.titleLines.length).toBeGreaterThan(1);
  expect(layout.entities[0]!.rows[0]!.height).toBeGreaterThan(32);
  const methodsEntity = layout.entities[1]!;
  expect(methodsEntity.methodsY).toBe(methodsEntity.headerHeight + 32);
  expect(methodsEntity.methods.map(method => method.id)).toEqual(['calculate', 'clear']);
  expect(methodsEntity.methods[0]!.signatureLines.length).toBeGreaterThan(1);
  expect(methodsEntity.methods[0]!.descriptionLines.length).toBeGreaterThan(1);
  expect(methodsEntity.methods[1]!.descriptionLines).toEqual([]);
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

it('routes attribute-only parcel and payment associations with one rounded elbow and labels above their horizontal lanes', () => {
  const domain = structuredClone(fixture.domain) as Explanation['domain'];
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
