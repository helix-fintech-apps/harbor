// Persistence port used by the service. Rows are snake_case and match the SQL tables 1:1,
// so the same service runs on Postgres (SupabaseStore, api Edge Function) and in memory
// (MemoryStore: unit/integration tests and the browser demo mode).

import { assertBalanced, type Txn } from "../domain/ledger.ts";

export type Row = Record<string, any>;

export interface LedgerRow { txn_id: string; kind: string; ref: string | null; at: string; account: string; party: string | null; debit: number; credit: number }

export interface Store {
  insert(table: string, row: Row): Promise<Row>;
  update(table: string, match: Row, patch: Row): Promise<void>;
  one(table: string, match: Row): Promise<Row | undefined>;
  list(table: string, match?: Row): Promise<Row[]>;
  /** Post a balanced txn atomically. Same idempotency key => same txn id, no new lines. */
  postLedger(t: Txn, idempotencyKey?: string): Promise<string>;
  ledger(filter?: { account?: string; party?: string; limit?: number }): Promise<LedgerRow[]>;
}

export function uuid(): string {
  return globalThis.crypto.randomUUID();
}

const matches = (r: Row, m?: Row) => !m || Object.entries(m).every(([k, v]) => r[k] === v);

export class MemoryStore implements Store {
  tables: Record<string, Row[]> = {};
  txns: { id: string; kind: string; ref: string | null; idempotency_key: string | null; created_at: string }[] = [];
  lines: { txn_id: string; account: string; party: string | null; debit: number; credit: number }[] = [];
  constructor(private clock: () => Date = () => new Date()) {}

  private t(name: string) { return (this.tables[name] ??= []); }
  async insert(table: string, row: Row) {
    const r = { id: uuid(), created_at: this.clock().toISOString(), ...row };
    if (table === "card_refunds" && this.t(table).some((x) => x.id === r.id)) throw new Error("duplicate key card_refunds");
    this.t(table).push(r);
    return { ...r };
  }
  async update(table: string, match: Row, patch: Row) {
    for (const r of this.t(table)) if (matches(r, match)) Object.assign(r, patch);
  }
  async one(table: string, match: Row) {
    const r = this.t(table).find((x) => matches(x, match));
    return r ? { ...r } : undefined;
  }
  async list(table: string, match?: Row) {
    return this.t(table).filter((x) => matches(x, match)).map((x) => ({ ...x }));
  }
  async postLedger(t: Txn, idempotencyKey?: string) {
    if (idempotencyKey) {
      const prev = this.txns.find((x) => x.idempotency_key === idempotencyKey);
      if (prev) return prev.id;
    }
    assertBalanced(t);
    const id = uuid();
    this.txns.push({ id, kind: t.kind, ref: t.ref ?? null, idempotency_key: idempotencyKey ?? null, created_at: this.clock().toISOString() });
    for (const l of t.lines) this.lines.push({ txn_id: id, account: l.account, party: l.party ?? null, debit: l.debit, credit: l.credit });
    return id;
  }
  async ledger(filter: { account?: string; party?: string; limit?: number } = {}) {
    const byId = new Map(this.txns.map((t) => [t.id, t]));
    const out = this.lines
      .filter((l) => (!filter.account || l.account === filter.account) && (!filter.party || l.party === filter.party))
      .map((l) => { const t = byId.get(l.txn_id)!; return { ...l, kind: t.kind, ref: t.ref, at: t.created_at }; });
    return filter.limit ? out.slice(-filter.limit) : out;
  }
  toJSON() { return { tables: this.tables, txns: this.txns, lines: this.lines }; }
  load(data: { tables: Record<string, Row[]>; txns: MemoryStore["txns"]; lines: MemoryStore["lines"] }) {
    this.tables = data.tables; this.txns = data.txns; this.lines = data.lines;
  }
}

/**
 * Postgres store via supabase-js (service role). `client` is a SupabaseClient; typed loosely so the
 * shared code has no npm/esm import. Ledger posts go through the `post_ledger_txn` SQL function
 * (atomic + balanced + idempotent).
 */
export class SupabaseStore implements Store {
  constructor(private client: any) {}
  private check<T>(r: { data: T; error: any }): T {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }
  async insert(table: string, row: Row) {
    return this.check(await this.client.from(table).insert(row).select().single()) as Row;
  }
  async update(table: string, match: Row, patch: Row) {
    this.check(await this.client.from(table).update(patch).match(match));
  }
  async one(table: string, match: Row) {
    return (this.check(await this.client.from(table).select("*").match(match).limit(1)) as Row[])[0];
  }
  async list(table: string, match: Row = {}) {
    return this.check(await this.client.from(table).select("*").match(match)) as Row[];
  }
  async postLedger(t: Txn, idempotencyKey?: string) {
    assertBalanced(t);
    return this.check(await this.client.rpc("post_ledger_txn", { p_kind: t.kind, p_ref: t.ref ?? null, p_idem: idempotencyKey ?? null, p_lines: t.lines })) as string;
  }
  async ledger(filter: { account?: string; party?: string; limit?: number } = {}) {
    let q = this.client.from("ledger_lines").select("txn_id, account, party, debit, credit, ledger_txns(kind, ref, created_at)");
    if (filter.account) q = q.eq("account", filter.account);
    if (filter.party) q = q.eq("party", filter.party);
    q = q.order("id", { ascending: true });
    if (filter.limit) q = q.limit(filter.limit);
    const rows = this.check(await q) as any[];
    return rows.map((r) => ({ txn_id: r.txn_id, account: r.account, party: r.party, debit: Number(r.debit), credit: Number(r.credit), kind: r.ledger_txns.kind, ref: r.ledger_txns.ref, at: r.ledger_txns.created_at }));
  }
}
