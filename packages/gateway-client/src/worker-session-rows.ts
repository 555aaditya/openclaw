type Row = { key: string; [field: string]: unknown };
type Window = { rows: Map<string, Row>; serialized: Map<string, string> };
type Delta = {
  workerRows: true;
  window: string;
  metadata: Record<string, unknown>;
  upserts: Row[];
  order: string[];
};

/** Transport projection only; filtering and receipt reconciliation keep their existing owner. */
export class GatewayWorkerSessionRows {
  private readonly windows = new Map<string, Window>();

  clear(): void {
    this.windows.clear();
  }

  encode(method: string, params: unknown, value: unknown): unknown {
    if (
      method !== "sessions.list" ||
      !value ||
      typeof value !== "object" ||
      !("sessions" in value) ||
      !Array.isArray(value.sessions)
    )
      return value;
    const id = JSON.stringify(params ?? {});
    const previous = this.windows.get(id);
    const next: Window = { rows: new Map(), serialized: new Map() };
    const upserts: Row[] = [];
    const order: string[] = [];
    for (const row of value.sessions as Row[]) {
      const serialized = JSON.stringify(row);
      order.push(row.key);
      next.rows.set(row.key, row);
      next.serialized.set(row.key, serialized);
      if (previous?.serialized.get(row.key) !== serialized) upserts.push(row);
    }
    // A prototype holds only the latest bounded set of query windows.
    if (!previous && this.windows.size >= 16)
      this.windows.delete(this.windows.keys().next().value!);
    this.windows.set(id, next);
    const { sessions: _, ...metadata } = value;
    return { workerRows: true, window: id, metadata, upserts, order } satisfies Delta;
  }

  decode(value: unknown): unknown {
    if (
      !value ||
      typeof value !== "object" ||
      !("workerRows" in value) ||
      value.workerRows !== true
    )
      return value;
    const delta = value as Delta;
    const previous = this.windows.get(delta.window);
    const updated = new Map(delta.upserts.map((row) => [row.key, row]));
    const rows = new Map<string, Row>();
    for (const key of delta.order) {
      const row = updated.get(key) ?? previous?.rows.get(key);
      if (!row) throw new Error("gateway worker row baseline missing");
      rows.set(key, row);
    }
    if (!previous && this.windows.size >= 16)
      this.windows.delete(this.windows.keys().next().value!);
    this.windows.set(delta.window, { rows, serialized: new Map() });
    return { ...delta.metadata, sessions: [...rows.values()] };
  }
}
