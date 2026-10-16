import authored from '../../../examples/order-lifecycle.json';

const { overview, topics, comparisons, ...document } = authored;
export default { ...document, scenarios: authored.scenarios.map(({ labels, ...scenario }) => scenario) };
