import { describe, expect, it } from 'vitest';
import fixture from '../../examples/order-lifecycle.json';
import { useNavigation } from '../src/navigation';
import { compareInstances, compareLinks, formatValue } from '../src/snapshots';
import type { Explanation } from '../src/model';

const document = fixture as Explanation;

describe('recorded traversal', () => {
  it('keeps revisits attached to occurrence IDs and shows only the walked prefix', () => {
    const viewer = useNavigation();
    viewer.load(document);
    viewer.selectScenario('duplicate-callback');
    viewer.selectOccurrence('duplicate-first-check');
    expect(viewer.history.value.map(item => item.id)).toEqual(['duplicate-received', 'duplicate-first-check']);
    expect(viewer.occurrencesAtNode('check').map(item => item.id)).toEqual(['duplicate-first-check', 'duplicate-verification']);
    viewer.selectOccurrence('duplicate-verification');
    expect(viewer.occurrence.value?.after.instances.find(item => item.entityId === 'receipt')?.values.lookupCount).toBe(2);
    viewer.selectOccurrence('capture');
    expect(viewer.occurrence.value?.id).toBe('duplicate-verification');
    viewer.selectScenario('successful-callback');
    viewer.step(1);
    viewer.selectScenario('duplicate-callback');
    expect(viewer.occurrence.value?.id).toBe('duplicate-verification');
    viewer.step(-1);
    expect(viewer.history.value.map(item => item.id)).toEqual(['duplicate-received', 'duplicate-first-check', 'duplicate-existing']);
    viewer.selectOccurrence('duplicate-ignored');
    viewer.step(1);
    expect(viewer.occurrence.value?.id).toBe('duplicate-ignored');
  });

  it('preserves stable selections across revision reload and resets removed occurrence IDs', () => {
    const viewer = useNavigation();
    viewer.load(document);
    viewer.selectScenario('duplicate-callback');
    viewer.selectOccurrence('duplicate-verification');
    const revision = structuredClone(document);
    revision.scenarios.reverse();
    revision.scenarios.find(item => item.id === 'duplicate-callback')!.occurrences[3]!.narration = 'Updated recorded narration';
    viewer.load(revision, true);
    expect(viewer.scenarioId.value).toBe('duplicate-callback');
    expect(viewer.occurrence.value?.id).toBe('duplicate-verification');
    expect(viewer.occurrence.value?.narration).toBe('Updated recorded narration');
    const next = structuredClone(revision);
    next.scenarios.find(item => item.id === 'duplicate-callback')!.occurrences = [next.scenarios.find(item => item.id === 'duplicate-callback')!.occurrences[0]!];
    viewer.load(next, true);
    expect(viewer.occurrence.value?.id).toBe('duplicate-received');
  });
});

describe('concrete state', () => {
  it('distinguishes uncaptured attributes, null, instance creation, and removal', () => {
    const success = document.scenarios[0]!;
    const received = compareInstances(document.domain.entities, success.occurrences[0]!.before, success.occurrences[0]!.after);
    const receipt = received.find(item => item.id === 'rcpt-481')!;
    expect(receipt.change).toBe('created');
    expect(formatValue(receipt.attributes.find(item => item.id === 'responseStatus')!.before)).toBe('Absent');
    expect(formatValue(receipt.attributes.find(item => item.id === 'responseStatus')!.after)).toBe('null');
    const capture = success.occurrences[2]!;
    const failure = compareInstances(document.domain.entities, capture.before, capture.after).find(item => item.id === 'pay-72')!.attributes.find(item => item.id === 'failureReason')!;
    expect(failure.change).toBe('changed');
    expect(formatValue(failure.before)).toBe('Uncaptured');
    expect(formatValue(failure.after)).toBe('null');
    const closed = document.scenarios[3]!.occurrences[3]!;
    const removed = compareInstances(document.domain.entities, closed.before, closed.after).find(item => item.id === 'ful-31')!;
    expect(removed.change).toBe('removed');
    expect(removed.attributes.map(attribute => formatValue(attribute.after))).toEqual(['Absent', 'Absent']);
    expect(compareLinks(document, closed.before, closed.after).map(link => link.change)).toEqual(['removed', 'removed', 'unchanged']);
  });

  it('compares structured JSON values by content while retaining array order', () => {
    const entities = [{ id: 'entity', label: 'Entity', attributes: [{ id: 'value', label: 'Value' }] }];
    const before = { instances: [{ id: 'instance', entityId: 'entity', values: { value: { a: 1, b: [2, 3] } } }], links: [] };
    const after = { instances: [{ id: 'instance', entityId: 'entity', values: { value: { b: [2, 3], a: 1 } } }], links: [] };
    expect(compareInstances(entities, before, after)[0]!.change).toBe('unchanged');
    after.instances[0]!.values.value.b = [3, 2];
    expect(compareInstances(entities, before, after)[0]!.change).toBe('changed');
    expect(formatValue({ kind: 'value', value: 'null' })).toBe('"null"');
  });
});
