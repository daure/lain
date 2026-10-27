import authored from '../../../examples/order-lifecycle.json';

const { overview, topics, comparisons, wiring, ...document } = authored;
export default {
  ...document,
  diagrams: authored.diagrams.filter(diagram => diagram.id !== 'warehouse-dispatch-flow'),
  scenarios: authored.scenarios.filter(scenario => scenario.id !== 'warehouse-ui-dispatch').map(({ labels, ...scenario }) => ({
    ...scenario,
    occurrences: scenario.occurrences.map(({ wiringRefs, ...occurrence }) => occurrence),
  })),
};
