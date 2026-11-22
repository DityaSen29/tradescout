import neo4j, { type Driver } from "neo4j-driver";
import type { GraphSink, GNode, GEdge } from "./model.js";

/** Neo4j mirror of the context graph. Buffers writes and flushes them in one transaction per run. */
export class Neo4jGraph implements GraphSink {
  private driver: Driver;
  private nodes: GNode[] = [];
  private edges: GEdge[] = [];
  constructor(uri = process.env.NEO4J_URI ?? "bolt://localhost:7687", user = process.env.NEO4J_USER ?? "neo4j", password = process.env.NEO4J_PASSWORD ?? "") {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password), { connectionTimeout: 3000 });
  }
  upsertNode(n: GNode) { this.nodes.push(n); }
  upsertEdge(e: GEdge) { this.edges.push(e); }
  static async available(): Promise<boolean> {
    try { const g = new Neo4jGraph(); await g.driver.verifyConnectivity(); await g.driver.close(); return true; } catch { return false; }
  }
  async flush(runId?: string) {
    const session = this.driver.session();
    try {
      await session.executeWrite(async tx => {
        for (const n of this.nodes) {
          await tx.run(`MERGE (x:${n.label} {id: $id}) SET x += $props, x.run_id = $run`, { id: n.id, props: clean(n.props), run: runId ?? null });
        }
        for (const e of this.edges) {
          await tx.run(`MATCH (a {id: $from}), (b {id: $to}) MERGE (a)-[r:${e.type}]->(b) SET r += $props`, { from: e.from, to: e.to, props: clean(e.props) });
        }
      });
    } finally { await session.close(); await this.driver.close(); }
  }
}
function clean(p: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    out[k] = (v !== null && typeof v === "object" && !Array.isArray(v)) ? JSON.stringify(v) : Array.isArray(v) ? v.map(x => typeof x === "object" ? JSON.stringify(x) : x) : v;
  }
  return out;
}
