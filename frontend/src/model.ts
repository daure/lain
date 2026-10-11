export type EntityMethod = { id: string; signature: string; description: string };
export type Entity = { id: string; label: string; attributes: { id: string; label: string }[]; methods?: EntityMethod[] };
export type Relationship = {
  id: string;
  label: string;
  sourceEntityId: string;
  targetEntityId: string;
  sourceCardinality: 'one' | 'many';
  targetCardinality: 'one' | 'many';
};
export type Diagram = {
  id: string;
  title: string;
  kind: 'flow' | 'state' | 'process' | 'sequence';
  nodes: { id: string; label: string; entityIds: string[] }[];
  edges: { id: string; sourceNodeId: string; targetNodeId: string; label: string }[];
  sequence?: {
    participants: { id: string; label: string }[];
    messages: { nodeId: string; fromParticipantId: string; toParticipantId: string }[];
    body: SequenceStep[];
  };
};
export type SequenceOperand = { id: string; guard: string; body: SequenceStep[] };
export type SequenceStep =
  | { kind: 'message'; nodeId: string }
  | { kind: 'alt'; id: string; operands: SequenceOperand[] }
  | { kind: 'opt' | 'loop'; id: string; guard: string; body: SequenceStep[] };
export type Snapshot = {
  instances: { id: string; entityId: string; values: Record<string, unknown> }[];
  links: { relationshipId: string; sourceInstanceId: string; targetInstanceId: string }[];
};
export type Occurrence = {
  id: string;
  nodeId: string;
  incomingEdgeId: string | null;
  trigger: string | null;
  narration: string;
  before: Snapshot;
  after: Snapshot;
};
export type Scenario = { id: string; title: string; diagramId: string; occurrences: Occurrence[] };
export type Explanation = {
  schemaVersion: 1;
  title: string;
  description: string;
  domain: { entities: Entity[]; relationships: Relationship[] };
  diagrams: Diagram[];
  scenarios: Scenario[];
};
export type StoredExplanation = { id: string; revision: number; updatedAtMs: number; document: Explanation };
export type ExplanationSummary = {
  id: string;
  title: string;
  description: string;
  revision: number;
  updatedAtMs: number;
  diagramCount: number;
  scenarioCount: number;
};
export type ChangeEvent = { id: string; revision: number; deleted?: boolean };
