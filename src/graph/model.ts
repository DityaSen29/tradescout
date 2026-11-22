/**
 * The context graph. Every run builds a small graph around the request: the product family and HS code,
 * the keywords a distributor of that product uses, the candidate companies, the people at them, the signals
 * attached to each company, and the evidence behind every fact. Ranking reads this graph; Neo4j mirrors it
 * so it can be explored and shown.
 */
export type NodeLabel = "Request" | "HS" | "Family" | "Keyword" | "Country" | "Company" | "Person" | "Signal" | "Evidence" | "Policy";
export type EdgeType = "ASKS_FOR" | "IN_MARKET" | "MAPS_TO" | "BELONGS_TO" | "MATCHES" | "LOCATED_IN" | "WORKS_AT" | "HAS_SIGNAL" | "SUPPORTED_BY" | "SIMILAR_TO" | "COMPETES_WITH" | "AFFECTED_BY";

export interface GNode { label: NodeLabel; id: string; props: Record<string, unknown> }
export interface GEdge { from: string; to: string; type: EdgeType; props: Record<string, unknown> }

export interface GraphSink {
  upsertNode(n: GNode): void;
  upsertEdge(e: GEdge): void;
  flush?(): Promise<void>;
}

/** In-memory graph: the source of truth for scoring inside a run. */
export class MemoryGraph implements GraphSink {
  nodes = new Map<string, GNode>();
  out = new Map<string, GEdge[]>();
  in = new Map<string, GEdge[]>();
  upsertNode(n: GNode) {
    const prev = this.nodes.get(n.id);
    this.nodes.set(n.id, prev ? { ...prev, props: { ...prev.props, ...n.props } } : { ...n, props: { ...n.props } });
  }
  upsertEdge(e: GEdge) {
    const list = this.out.get(e.from) ?? [];
    const existing = list.find(x => x.to === e.to && x.type === e.type);
    if (existing) { existing.props = { ...existing.props, ...e.props }; return; }
    const edge = { ...e, props: { ...e.props } };
    list.push(edge); this.out.set(e.from, list);
    const inList = this.in.get(e.to) ?? []; inList.push(edge); this.in.set(e.to, inList);
  }
  edgesFrom(id: string, type?: EdgeType) { return (this.out.get(id) ?? []).filter(e => !type || e.type === type); }
  edgesTo(id: string, type?: EdgeType) { return (this.in.get(id) ?? []).filter(e => !type || e.type === type); }
  byLabel(label: NodeLabel) { return [...this.nodes.values()].filter(n => n.label === label); }
  toJSON() { return { nodes: [...this.nodes.values()], edges: [...this.out.values()].flat() }; }
}

export const nid = (label: NodeLabel, key: string) => `${label}:${key}`;
