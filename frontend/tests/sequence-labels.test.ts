// @vitest-environment jsdom
import { createApp, h, nextTick } from 'vue';
import { expect, it } from 'vitest';
import SequenceView from '../src/components/SequenceView.vue';
import type { Diagram, Scenario } from '../src/model';

it.each([false, true])('wraps sequence labels into two lines before truncating with compact=%s', async compact => {
  const labels = ['Request approved prices for the customer', 'GET /price-records/assignments/approved/for/customer/including/contracts', 'Return'];
  const diagram: Diagram = {
    id: 'prices', title: 'Approved prices', kind: 'sequence',
    nodes: labels.map((label, index) => ({ id: `message-${index}`, label, entityIds: [] })),
    edges: [],
    sequence: {
      participants: [{ id: 'client', label: 'dice-mcp-server (AI agent)' }, { id: 'service', label: 'Price service' }],
      messages: labels.map((_, index) => ({ nodeId: `message-${index}`, fromParticipantId: 'client', toParticipantId: index === 2 ? 'client' : 'service' })),
      body: labels.map((_, index) => ({ kind: 'message', nodeId: `message-${index}` })),
    },
  };
  const scenario: Scenario = {
    id: 'approved', title: 'Approved request', diagramId: diagram.id,
    occurrences: labels.map((_, index) => ({ id: `visit-${index}`, nodeId: `message-${index}`, incomingEdgeId: null,
      trigger: null, narration: '', before: { instances: [], links: [] }, after: { instances: [], links: [] } })),
  };
  const root = document.createElement('div');
  const app = createApp({ render: () => h(SequenceView, { diagram, scenario, compact, currentOccurrenceId: compact ? 'visit-1' : 'visit-0' }) });
  app.mount(root);
  await nextTick();
  try {
    const lines = (selector: string) => [...root.querySelectorAll(`${selector} text > tspan`)].map(line => line.textContent);
    expect(lines('[data-participant-id="client"]')).toEqual(['dice-mcp-server (AI', 'agent)']);
    expect(lines('[data-participant-id="service"]')).toEqual(['Price service']);
    expect(lines('[data-node-id="message-0"]')).toEqual(compact ? ['1. Request approved prices', 'for the customer'] : ['Request approved prices for', 'the customer']);
    expect(lines('[data-node-id="message-1"]')).toEqual(compact ? ['2. GET /price-records/assig', 'nments/approved/for/custom…'] : ['GET /price-records/assignme', 'nts/approved/for/customer/…']);
    expect(root.querySelector('[data-node-id="message-1"] title')!.textContent).toContain(labels[1]);
    const messages = [...root.querySelectorAll('.sequence-message')];
    for (let index = 0; index < messages.length; index++) {
      const row = messages[index]!.querySelector('.sequence-row')!;
      const label = messages[index]!.querySelector('svg')!;
      expect(Number(label.getAttribute('y'))).toBeGreaterThan(Number(row.getAttribute('y')));
      expect(Number(label.getAttribute('y')) + Number(label.getAttribute('height'))).toBeLessThan(Number(row.getAttribute('y')) + Number(row.getAttribute('height')));
      if (index > 0) {
        const previous = messages[index - 1]!.querySelector('.sequence-row')!;
        expect(Number(row.getAttribute('y'))).toBeGreaterThan(Number(previous.getAttribute('y')) + Number(previous.getAttribute('height')));
      }
    }
  } finally { app.unmount(); }
});
